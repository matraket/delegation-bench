import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Drives one multi-turn pi RPC session (see rpc.md / rpc-commands.md):
// - a turn is sent with `prompt`; disposition "handled" means no run started;
// - otherwise the turn ends when `agent_settled` has fired (not agent_end),
//   no subagent task of this session is still queued/running, and no new run
//   started during a quiet window after the later of the two. Background
//   completions re-trigger the parent (gentle-agents deliver + triggerTurn),
//   so the quiet window catches that follow-up run.
// - Dialog extension UI requests are answered with `cancelled: true` (the
//   safe default: decline) and recorded; fire-and-forget ones are recorded.

const PENDING_STATUSES = new Set(["queued", "running", "waiting"]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export const DRIVER_DEFAULTS = Object.freeze({
	deadlineMs: 15 * 60_000,
	quietMs: 1_000,
	backgroundQuietMs: 5_000,
	pollMs: 250,
	requestTimeoutMs: 30_000,
	abortGraceMs: 15_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gentleAgentsDetails(record) {
	const candidates = [record?.result?.details, record?.message?.details, record?.entry?.details, record?.entry?.data];
	for (const details of candidates) {
		const task = details?.gentleAgents;
		if (task && typeof task.taskId === "string") return task;
	}
	return undefined;
}

async function readTaskRecord(agentHome, taskId) {
	try {
		return JSON.parse(await readFile(join(agentHome, "gentle-agents", "tasks", `${taskId}.json`), "utf8"))?.task;
	} catch {
		return undefined;
	}
}

/** Task ids with a persisted record for this parent that is still pending. */
async function pendingRecordsFor(agentHome, sessionId) {
	const dir = join(agentHome, "gentle-agents", "tasks");
	let names;
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const pending = [];
	for (const name of names) {
		const task = await readTaskRecord(agentHome, name.slice(0, -5));
		if (task?.parentSessionId === sessionId && PENDING_STATUSES.has(task.status)) pending.push(task.id);
	}
	return pending;
}

/** Live state of the session, updated from every incoming record. */
function createTracker(client, { now = Date.now } = {}) {
	const state = {
		running: false,
		settles: 0,
		settledAt: 0,
		lastFinishAt: 0,
		exited: undefined,
		tasks: new Map(),
		uiRequests: [],
		turnId: null,
	};
	const unsubscribe = client.onRecord((record) => {
		switch (record?.type) {
			case "__exit":
				state.exited = record;
				return;
			case "agent_start":
				state.running = true;
				return;
			case "agent_settled":
				state.running = false;
				state.settles += 1;
				state.settledAt = now();
				return;
			case "extension_ui_request": {
				const request = { id: record.id, turnId: state.turnId, method: record.method, title: record.title ?? record.message ?? null, at: now(), answered: false };
				if (DIALOG_METHODS.has(record.method)) {
					const answer = { cancelled: true };
					client.send({ type: "extension_ui_response", id: record.id, ...answer });
					request.answered = true;
					request.answer = answer;
				}
				state.uiRequests.push(request);
				return;
			}
			default:
				break;
		}
		const task = gentleAgentsDetails(record);
		if (task) {
			const known = state.tasks.get(task.taskId) ?? { taskId: task.taskId, agent: task.agent ?? null, mode: task.mode ?? null, turnId: state.turnId, firstSeenAt: now() };
			known.status = task.status ?? known.status;
			if (!PENDING_STATUSES.has(known.status) && known.finishedAt === undefined) {
				known.finishedAt = now();
				state.lastFinishAt = known.finishedAt;
			}
			state.tasks.set(task.taskId, known);
		}
	});
	return { state, unsubscribe };
}

/** Resolve pending tasks against disk; returns the ids still pending. */
async function stillPending(state, agentHome, sessionId) {
	const pending = [];
	for (const task of state.tasks.values()) {
		if (!PENDING_STATUSES.has(task.status)) continue;
		const record = agentHome ? await readTaskRecord(agentHome, task.taskId) : undefined;
		if (record && !PENDING_STATUSES.has(record.status)) {
			task.status = record.status;
			task.finishedAt = Date.now();
			task.resolvedBy = "task-record";
			state.lastFinishAt = task.finishedAt;
		} else {
			pending.push(task.taskId);
		}
	}
	if (agentHome && sessionId) {
		for (const id of await pendingRecordsFor(agentHome, sessionId)) if (!pending.includes(id)) pending.push(id);
	}
	return pending;
}

async function safeRequest(client, type, options, errors, turnId) {
	try {
		const response = await client.request(type, {}, { timeoutMs: options.requestTimeoutMs });
		if (!response.success) errors.push({ turnId, command: type, error: response.error ?? "failed" });
		return response.success ? response.data : undefined;
	} catch (error) {
		errors.push({ turnId, command: type, error: error.message });
		return undefined;
	}
}

async function waitForTurnEnd(state, options, context, startedAt) {
	const quietMs = options.quietMs ?? (options.background ? DRIVER_DEFAULTS.backgroundQuietMs : DRIVER_DEFAULTS.quietMs);
	while (true) {
		if (state.exited) return "exited";
		if (Date.now() - startedAt > options.deadlineMs) return "deadline";
		if (!state.running && state.settles > context.settlesBefore) {
			const pending = await stillPending(state, options.agentHome, context.sessionId);
			const quietSince = Math.max(state.settledAt, state.lastFinishAt);
			if (pending.length === 0 && !state.running && Date.now() - quietSince >= quietMs) return "settled";
		}
		await sleep(options.pollMs);
	}
}

async function runTurn(client, tracker, turn, options, context) {
	const { state } = tracker;
	state.turnId = turn.id;
	const startedAt = Date.now();
	const result = { id: turn.id, prompt: turn.prompt, startedAt: new Date(startedAt).toISOString(), disposition: null, status: null };
	const deadlineMs = turn.deadlineMs ?? options.deadlineMs;
	context.settlesBefore = state.settles;
	let response;
	try {
		response = await client.request("prompt", { message: turn.prompt }, { timeoutMs: options.requestTimeoutMs });
	} catch (error) {
		response = { success: false, error: error.message };
	}
	if (!response.success) {
		result.status = state.exited ? "exited" : "error";
		result.error = `prompt rejected: ${response.error ?? "unknown error"}`;
	} else {
		result.disposition = response.data?.disposition ?? null;
		if (result.disposition === "handled") {
			result.status = "handled";
		} else {
			result.status = await waitForTurnEnd(state, { ...options, deadlineMs }, context, startedAt);
			if (result.status === "deadline") {
				result.error = `turn exceeded its deadline of ${deadlineMs} ms; aborted`;
				await safeRequest(client, "abort", options, context.errors, turn.id);
				const graceEnd = Date.now() + options.abortGraceMs;
				while (state.running && !state.exited && Date.now() < graceEnd) await sleep(options.pollMs);
			} else if (result.status === "exited") {
				result.error = `pi exited during the turn (code ${state.exited.code}, signal ${state.exited.signal})`;
			}
		}
	}
	const endedAt = Date.now();
	result.endedAt = new Date(endedAt).toISOString();
	result.durationMs = endedAt - startedAt;
	result.backgroundTasks = [...state.tasks.values()].filter((task) => task.turnId === turn.id).map((task) => ({ ...task }));
	if (!state.exited) {
		result.stats = (await safeRequest(client, "get_session_stats", options, context.errors, turn.id)) ?? null;
		const last = await safeRequest(client, "get_last_assistant_text", options, context.errors, turn.id);
		result.lastAssistantText = last?.text ?? null;
	}
	return result;
}

/**
 * Run ordered turns on a started RpcClient.
 * options: deadlineMs, quietMs, pollMs, requestTimeoutMs, abortGraceMs,
 *   background (longer default quiet window), agentHome (task records).
 * Stops at the first turn that times out, errors, or loses the process.
 */
export async function driveSession(client, turns, userOptions = {}) {
	const options = { ...DRIVER_DEFAULTS, ...userOptions };
	if (userOptions.quietMs === undefined) options.quietMs = options.background ? options.backgroundQuietMs : DRIVER_DEFAULTS.quietMs;
	const tracker = createTracker(client);
	const errors = [];
	const out = { sessionFile: null, sessionId: null, status: "completed", turns: [], uiRequests: tracker.state.uiRequests, errors };
	try {
		const state = await safeRequest(client, "get_state", options, errors, null);
		out.sessionFile = state?.sessionFile ?? null;
		out.sessionId = state?.sessionId ?? null;
		if (!state) {
			out.status = tracker.state.exited ? "exited" : "error";
			return out;
		}
		const context = { sessionId: out.sessionId, errors, settlesBefore: 0 };
		for (const turn of turns) {
			const result = await runTurn(client, tracker, turn, options, context);
			out.turns.push(result);
			if (!["settled", "handled"].includes(result.status)) {
				out.status = result.status;
				break;
			}
		}
		return out;
	} finally {
		tracker.unsubscribe();
	}
}
