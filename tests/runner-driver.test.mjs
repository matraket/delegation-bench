import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../lib/runner/rpc-client.mjs";
import { DRIVER_DEFAULTS, driveSession, resolveDriverOptions } from "../lib/runner/driver.mjs";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const FAST = { deadlineMs: 5000, quietMs: 50, pollMs: 10, requestTimeoutMs: 5000, abortGraceMs: 2000 };

async function session(turns, options = {}, { seed } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bench-driver-"));
	const home = join(dir, "home");
	await seed?.(home);
	const logPath = join(dir, "events.jsonl");
	const client = new RpcClient({
		command: process.execPath,
		args: [FAKE_PI, "--home", home, "--", "--mode", "rpc", "--session-dir", join(home, "sessions", "bench")],
		cwd: dir,
		env: { ...process.env },
		logPath,
		stderrPath: join(dir, "stderr.log"),
	});
	await client.start();
	const questions = turns.map((prompt, index) => ({ id: `t${index + 1}`, prompt }));
	const result = await driveSession(client, questions, { ...FAST, agentHome: home, ...options });
	await client.close();
	const log = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	return { result, log, home };
}

test("drives ordered turns, waiting for agent_settled, and records stats and answers", async () => {
	const { result, log } = await session(["first question", "second question"]);
	assert.equal(result.status, "completed");
	assert.match(result.sessionFile, /fake-session-0001\.jsonl$/);
	assert.equal(result.sessionId, "fake-session-0001");
	assert.deepEqual(result.turns.map((turn) => turn.status), ["settled", "settled"]);
	assert.equal(result.turns[1].disposition, "started");
	assert.equal(result.turns[1].lastAssistantText, "answer to: second question");
	assert.equal(result.turns[1].stats.tokens.input, 200);
	assert.ok(result.turns[0].durationMs >= 0);
	// Every record in both directions is logged.
	assert.ok(log.some((entry) => entry.dir === "out" && entry.record.type === "prompt"));
	assert.ok(log.some((entry) => entry.dir === "in" && entry.record.type === "agent_settled"));
});

test("reads CRLF-framed records and keeps U+2028/U+2029 inside answers", async () => {
	const { result } = await session(["[crlf] [u2028] go"]);
	assert.equal(result.turns[0].status, "settled");
	assert.equal(result.turns[0].lastAssistantText, "line separator paragraph");
});

test("a turn past its deadline is aborted and ends the run", async () => {
	const { result, log } = await session(["[slow] think forever", "never sent"], { deadlineMs: 300 });
	assert.equal(result.status, "deadline");
	assert.equal(result.turns.length, 1);
	assert.equal(result.turns[0].status, "deadline");
	assert.match(result.turns[0].error, /deadline of 300 ms/);
	assert.ok(log.some((entry) => entry.dir === "out" && entry.record.type === "abort"));
	assert.ok(!log.some((entry) => entry.dir === "out" && entry.record.message === "never sent"));
});

test("dialog UI requests are declined automatically and every UI request is recorded", async () => {
	const { result, log } = await session(["[ui] needs a confirm"]);
	assert.equal(result.turns[0].status, "settled");
	assert.match(result.turns[0].lastAssistantText, /"cancelled":true/);
	const confirm = result.uiRequests.find((request) => request.method === "confirm");
	assert.deepEqual({ ...confirm, at: undefined }, { at: undefined, id: "ui-1", turnId: "t1", method: "confirm", title: "Allow dangerous thing?", answered: true, answer: { cancelled: true } });
	const notify = result.uiRequests.find((request) => request.method === "notify");
	assert.equal(notify.answered, false);
	assert.ok(log.some((entry) => entry.dir === "out" && entry.record.type === "extension_ui_response" && entry.record.cancelled === true));
});

test("a handled prompt does not wait for a run and the next turn still runs", async () => {
	const { result } = await session(["/fake-command [handled]", "after"]);
	assert.equal(result.turns[0].status, "handled");
	assert.equal(result.turns[0].disposition, "handled");
	assert.equal(result.turns[1].status, "settled");
	assert.equal(result.status, "completed");
});

test("with background subagents, a turn ends only after the task finished and the parent settled again", async () => {
	const { result } = await session(["[background] delegate"], { background: true, quietMs: 100 });
	const [turn] = result.turns;
	assert.equal(turn.status, "settled");
	assert.equal(turn.lastAssistantText, "background result integrated");
	assert.deepEqual(turn.backgroundTasks.map(({ taskId, status }) => ({ taskId, status })), [{ taskId: "bg-task-1", status: "completed" }]);
});

test("pi exiting in the middle of a turn ends the run with status exited and the exit code", async () => {
	const { result } = await session(["[exit] crash now", "never sent"]);
	assert.equal(result.status, "exited");
	assert.equal(result.turns.length, 1);
	assert.equal(result.turns[0].status, "exited");
	assert.match(result.turns[0].error, /pi exited during the turn \(code 3, signal null\)/);
	assert.equal(result.turns[0].stats, undefined);
});

test("a pending-looking task record the event stream never mentioned does not hold the turn open", async () => {
	// Gentle Shell writes task records only when a task finishes, so a record
	// saying "running" is stale (for example from a crashed host) and is ignored.
	const seed = async (home) => {
		const dir = join(home, "gentle-agents", "tasks");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "stale-task.json"), JSON.stringify({ task: { id: "stale-task", parentSessionId: "fake-session-0001", status: "running" } }));
	};
	const { result } = await session(["plain question"], { deadlineMs: 1500 }, { seed });
	assert.equal(result.turns[0].status, "settled");
	assert.deepEqual(result.turns[0].backgroundTasks, []);
});

test("the quiet window is chosen in one place: explicit quietMs, else backgroundQuietMs with background on, else quietMs", () => {
	assert.equal(resolveDriverOptions({}).quietMs, DRIVER_DEFAULTS.quietMs);
	assert.equal(resolveDriverOptions({ background: true }).quietMs, DRIVER_DEFAULTS.backgroundQuietMs);
	assert.equal(resolveDriverOptions({ background: true, backgroundQuietMs: 30 }).quietMs, 30);
	assert.equal(resolveDriverOptions({ background: true, quietMs: 7 }).quietMs, 7);
	assert.equal(resolveDriverOptions({ background: false, backgroundQuietMs: 30 }).quietMs, DRIVER_DEFAULTS.quietMs);
});
