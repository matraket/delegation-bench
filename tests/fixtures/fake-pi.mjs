#!/usr/bin/env node
// Fake Gentle Shell launcher for runner tests. It accepts the launcher argv
// (`--home <H> --package-root <A> -- --mode rpc ... --session-dir <D>`),
// speaks the pi RPC JSONL protocol on stdio, and writes a session JSONL that
// the T1 analyzer can read. Prompt keywords select the scenario:
//   [handled]     answer disposition "handled" and start no run
//   [slow]        never settle on its own (deadline test); settles on abort
//   [ui]          emit a confirm extension_ui_request and wait for the answer
//   [crlf]        write records with CRLF endings, split mid-record
//   [u2028]       answer text containing U+2028 and U+2029
//   [background]  report a running background task, settle, then finish the
//                 task record on disk and re-trigger one more run
//   [exit]        start a run, then exit with code 3 in the middle of it
// Environment switches for shutdown tests:
//   FAKE_PI_STUBBORN=1         ignore stdin EOF and SIGTERM (only SIGKILL ends it)
//   FAKE_PI_GRANDCHILD=<file>  spawn a child in the same process group that
//                              ignores SIGTERM, and write its pid to <file>
// A marker file named by FAKE_PI_MARKER is written on start, so tests can
// prove whether a process was spawned at all.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
};
const home = valueAfter("--home");
const sessionDir = valueAfter("--session-dir");
if (process.env.FAKE_PI_MARKER) writeFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ argv, keySet: Boolean(process.env.NAN_API_KEY) }));
const stubborn = process.env.FAKE_PI_STUBBORN === "1";
if (stubborn) process.on("SIGTERM", () => {});
if (process.env.FAKE_PI_GRANDCHILD) {
	// The grandchild writes its pid only after its SIGTERM handler is installed.
	const script = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.FAKE_PI_GRANDCHILD, String(process.pid)); setInterval(() => {}, 1000);";
	spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

const sessionId = "fake-session-0001";
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() })}\n`);

let crlf = false;
let pendingUi;
let slowRun;
let lastText = null;
let entryCount = 0;
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function emit(record) {
	const line = JSON.stringify(record);
	if (!crlf) {
		process.stdout.write(`${line}\n`);
		return;
	}
	// CRLF framing, written in two pieces cut in the middle of the record
	// (the pipe may still coalesce them; tests/runner-jsonl covers exact splits).
	const cut = Math.floor(line.length / 2);
	process.stdout.write(line.slice(0, cut));
	process.stdout.write(`${line.slice(cut)}\r\n`);
}

function appendEntry(message) {
	entryCount += 1;
	appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: `e${entryCount}`, timestamp: new Date().toISOString(), message })}\n`);
}

function assistant(text) {
	const usage = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160 };
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) totals[key] += usage[key];
	const message = { role: "assistant", content: [{ type: "text", text }], provider: "nan", model: "fake", usage, stopReason: "stop" };
	appendEntry(message);
	lastText = text;
	emit({ type: "message_end", message });
}

function run(text, then) {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	setTimeout(() => {
		assistant(text);
		emit({ type: "agent_end", messages: [] });
		setTimeout(() => {
			emit({ type: "agent_settled" });
			then?.();
		}, 5);
	}, 20);
}

function startBackground() {
	const taskId = "bg-task-1";
	emit({ type: "agent_start" });
	emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "subagent_run", result: { content: [{ type: "text", text: "started" }], details: { gentleAgents: { taskId, agent: "gentle-ai-explore", status: "running", mode: "background" } } }, isError: false });
	assistant("delegated in background");
	emit({ type: "agent_end", messages: [] });
	emit({ type: "agent_settled" });
	// The child finishes later: record on disk, then the completion re-triggers the parent.
	setTimeout(() => {
		const dir = join(home, "gentle-agents", "tasks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${taskId}.json`), JSON.stringify({ task: { id: taskId, parentSessionId: sessionId, status: "completed", agent: "gentle-ai-explore" } }));
		setTimeout(() => run("background result integrated"), 30);
	}, 150);
}

function handlePrompt(command) {
	const message = String(command.message ?? "");
	if (message.includes("[crlf]")) crlf = true;
	if (message.includes("[handled]")) {
		emit({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
		return;
	}
	appendEntry({ role: "user", content: [{ type: "text", text: message }] });
	emit({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
	if (message.includes("[slow]")) {
		emit({ type: "agent_start" });
		slowRun = true;
		return;
	}
	if (message.includes("[ui]")) {
		emit({ type: "agent_start" });
		pendingUi = "ui-1";
		emit({ type: "extension_ui_request", id: pendingUi, method: "confirm", title: "Allow dangerous thing?", message: "fake" });
		emit({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "fyi", notifyType: "info" });
		return;
	}
	if (message.includes("[background]")) {
		startBackground();
		return;
	}
	if (message.includes("[exit]")) {
		emit({ type: "agent_start" });
		setTimeout(() => process.exit(3), 20);
		return;
	}
	const text = message.includes("[u2028]") ? "line separator paragraph" : `answer to: ${message}`;
	run(text);
}

function handle(command) {
	switch (command.type) {
		case "get_state":
			emit({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionFile, sessionId, isStreaming: false, messageCount: entryCount } });
			break;
		case "prompt":
			handlePrompt(command);
			break;
		case "abort":
			emit({ id: command.id, type: "response", command: "abort", success: true });
			if (slowRun) {
				slowRun = false;
				emit({ type: "agent_end", messages: [] });
				emit({ type: "agent_settled" });
			}
			break;
		case "extension_ui_response":
			if (command.id === pendingUi) {
				pendingUi = undefined;
				setTimeout(() => {
					assistant(`ui answered: ${JSON.stringify({ cancelled: command.cancelled ?? false, confirmed: command.confirmed ?? null })}`);
					emit({ type: "agent_end", messages: [] });
					emit({ type: "agent_settled" });
				}, 10);
			}
			break;
		case "get_session_stats":
			emit({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { sessionFile, sessionId, tokens: { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite }, contextUsage: { tokens: 150, contextWindow: 1000, percent: 15 } } });
			break;
		case "get_last_assistant_text":
			emit({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: lastText } });
			break;
		default:
			emit({ id: command.id, type: "response", command: command.type, success: false, error: `unsupported: ${command.type}` });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => {
	if (!stubborn) process.exit(0);
});
// Keep a stubborn process alive after stdin closes.
if (stubborn) setInterval(() => {}, 1000);
