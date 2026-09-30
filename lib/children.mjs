import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Child linkage in Gentle Shell (gentle-agents extension):
// - Every subagent_run tool result, and every pushed background completion
//   (custom_message "gentle-agents.result"), carries details.gentleAgents.taskId.
// - The host persists one task record per finished task at
//   <agentHome>/gentle-agents/tasks/<taskId>.json with parentSessionId and
//   the child's sessionPath (the RPC child's own session file).
// The child session header itself holds no parent reference, so the task
// record is the only explicit parent -> child link.

const PENDING_STATUSES = new Set(["queued", "running", "waiting"]);
// Only these tools return the finished task text (finishedText) to the parent;
// subagent_status, cancel, reply and friends reference the task without it.
const RESULT_TOOLS = new Set(["subagent_run", "subagent_result"]);
const PUSHED_RESULT = "gentle-agents.result";
const TOKENS_METHOD = "estimate:ceil(chars/4)";

function taskDetails(value) {
	const details = value?.details?.gentleAgents;
	return details && typeof details.taskId === "string" ? details : undefined;
}

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Task ids referenced by a parent session, in order of first appearance, with
 * every terminal result text the parent received for each one.
 */
export function collectDeliveries(entries) {
	const tasks = new Map();
	const touch = (details) => {
		if (!tasks.has(details.taskId)) tasks.set(details.taskId, { agent: details.agent, mode: details.mode, status: details.status, handoffs: [] });
		const task = tasks.get(details.taskId);
		task.status = details.status ?? task.status;
		return task;
	};
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "toolResult") {
			const details = taskDetails(entry.message);
			if (!details) continue;
			const task = touch(details);
			if (RESULT_TOOLS.has(entry.message.toolName) && !PENDING_STATUSES.has(details.status)) task.handoffs.push({ source: "tool-result", text: textOf(entry.message.content) });
		} else if (entry?.type === "custom_message" && entry.customType === PUSHED_RESULT) {
			const details = taskDetails(entry);
			if (!details) continue;
			touch(details).handoffs.push({ source: "pushed-result", text: textOf(entry.content) });
		}
	}
	return tasks;
}

/** All persisted task records across agent homes (first home wins on duplicate ids). */
export async function loadTaskRecords(agentHomes) {
	const records = new Map();
	for (const home of agentHomes) {
		const dir = join(home, "gentle-agents", "tasks");
		let names;
		try {
			names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const task = JSON.parse(await readFile(join(dir, name), "utf8"))?.task;
				if (typeof task?.id === "string" && !records.has(task.id)) records.set(task.id, task);
			} catch {
				// A half-written or foreign file is not a task record.
			}
		}
	}
	return records;
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** The recorded path if it exists, else the same file name under any agent home. */
async function locateChildSession(recordedPath, agentHomes) {
	if (await isFile(recordedPath)) return { path: recordedPath, pathResolvedBy: "recorded" };
	for (const home of agentHomes) {
		const candidate = join(home, "gentle-agents", "sessions", basename(recordedPath));
		if (await isFile(candidate)) return { path: candidate, pathResolvedBy: "basename" };
	}
	return undefined;
}

function handoffOf(delivery, record) {
	const handoffs = delivery?.handoffs ?? [];
	const first = handoffs[0] ?? (typeof record?.result === "string" ? { source: "task-record-result", text: record.result } : undefined);
	if (!first) return null;
	return { source: first.source, chars: first.text.length, tokens: Math.ceil(first.text.length / 4), tokensMethod: TOKENS_METHOD, deliveries: handoffs.length };
}

/**
 * Children of one parent session. Tasks are grouped by child session file,
 * because a continuation reuses the earlier child's session file.
 */
export async function discoverChildren(parent, agentHomes) {
	const deliveries = collectDeliveries(parent.entries);
	const records = await loadTaskRecords(agentHomes);
	const orphans = [...records.values()]
		.filter((record) => record.parentSessionId === parent.id && !deliveries.has(record.id))
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
		.map((record) => record.id);
	const children = new Map();
	const unresolvedTasks = [];
	for (const taskId of [...deliveries.keys(), ...orphans]) {
		const delivery = deliveries.get(taskId);
		const record = records.get(taskId);
		const task = {
			taskId,
			agent: record?.agent ?? delivery?.agent ?? null,
			mode: record?.mode ?? delivery?.mode ?? null,
			status: record?.status ?? delivery?.status ?? null,
			model: record?.model ?? null,
			referencedInParent: delivery !== undefined,
			handoff: handoffOf(delivery, record),
		};
		let reason;
		let located;
		if (!record) reason = "no-task-record";
		else if (record.parentSessionId !== parent.id) reason = "parent-mismatch";
		else if (typeof record.sessionPath !== "string" || record.sessionPath.length === 0) reason = "no-session-path";
		else if (!(located = await locateChildSession(record.sessionPath, agentHomes))) reason = "session-file-missing";
		if (reason) {
			unresolvedTasks.push({ ...task, reason, recordedSessionPath: record?.sessionPath ?? null });
			continue;
		}
		if (!children.has(located.path)) children.set(located.path, { ...located, tasks: [] });
		children.get(located.path).tasks.push(task);
	}
	return { children: [...children.values()], unresolvedTasks };
}
