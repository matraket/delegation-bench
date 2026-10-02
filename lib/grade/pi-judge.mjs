// Judge backend through plain `pi` (for example a ChatGPT subscription logged
// in to pi as `openai-codex`). One isolated, ephemeral `pi -p` process per
// answer: no session, tools, extensions, skills or context files, the judge
// system prompt as `--system-prompt` and the judge user message as the prompt
// argument. No shell is involved, stdin is closed, and the credential stays
// inside pi (NAN_API_KEY is not passed to it). Errors carry only a short code,
// never pi's stderr or the provider's message.
import { spawn } from "node:child_process";
import { JudgeError, withRetries } from "./judge.mjs";

const ISOLATION = ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files"];

/** The pi argument array for one judge call. `--` keeps the user message from being read as an option. */
export function piArgs({ model, system, user, jsonMode = true }) {
	return ["-p", ...ISOLATION, "--system-prompt", system, "--model", model, ...(jsonMode ? ["--mode", "json"] : []), "--", user];
}

// Checked in order; the first match wins. Retryable failures feed the batch
// circuit breaker once they outlive every retry, like HTTP 429 and 5xx.
const FAILURES = [
	["timeout", true, /timed? ?out|ETIMEDOUT/i],
	["network", true, /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|socket hang up|fetch failed|network error/i],
	["rate_limited", true, /rate.?limit|\b429\b|too many requests/i],
	["usage_limit", true, /usage limit|quota|billing|plan limit/i],
	["bad_model", false, /(unknown|invalid|unsupported) model|model\b[^\n]{0,60}\b(not found|not available|unknown|not supported|does not exist)|no models? match/i],
	["auth", false, /\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|\/login|log ?in\b|authenticat|credential|api key|token (has )?expired/i],
	["server", true, /\b5\d\d\b|overloaded|server error|service unavailable|bad gateway|temporarily unavailable|try again/i],
];

/** A short code and retryability for a pi failure text (stderr or a stream errorMessage). */
export function classifyPiFailure(text) {
	for (const [code, retryable, pattern] of FAILURES) if (pattern.test(text ?? "")) return { code, retryable };
	return { code: "failed", retryable: false };
}

const STDERR_LIMIT = 64 * 1024;

/** Runs pi once; resolves with exit code, stdout and (capped) stderr; kills it after `timeoutMs`. */
function runPi(command, args, { timeoutMs, env }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env });
		} catch (error) {
			resolve({ spawnError: error });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < STDERR_LIMIT) stderr += chunk; });
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ spawnError: error });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, timedOut });
		});
	});
}

/**
 * The last assistant `message_end` of a pi JSON event stream (JSONL, split on
 * LF only). Returns null when the stream holds none (truncated or broken).
 */
export function lastAssistantMessage(stdout) {
	let found = null;
	for (const line of stdout.split("\n")) {
		const text = line.replace(/\r$/, "").trim();
		if (!text) continue;
		let record;
		try {
			record = JSON.parse(text);
		} catch {
			continue;
		}
		if (record?.type === "message_end" && record.message?.role === "assistant") found = record.message;
	}
	return found;
}

/** pi usage -> judge usage; null when pi reported none (absent or all zero). */
function usageOf(usage) {
	const n = (v) => (Number.isFinite(v) ? v : 0);
	if (!usage) return null;
	const promptTokens = n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite);
	const completionTokens = n(usage.output);
	return promptTokens + completionTokens > 0 ? { promptTokens, completionTokens } : null;
}

const failure = (text, exit) => {
	const { code, retryable } = classifyPiFailure(text);
	return new JudgeError(`pi judge failed: ${code}${exit === undefined ? "" : ` (exit ${exit})`}`, { code, retryable });
};

/**
 * Returns judge(messages) -> { content, usage: {promptTokens, completionTokens} | null, attempts }.
 * `model` is the pi model (`<provider>/<id>[:thinking]`). In JSON mode the
 * reply and usage come from the last assistant message of the event stream; in
 * text mode the reply is stdout and usage is null (unavailable). Timeouts,
 * rate and usage limits, network and server errors are retried with the
 * shared backoff; auth, bad model, a missing pi and unknown failures are not.
 */
export function createPiJudge({
	model, command = "pi", jsonMode = true, timeoutMs = 120000, env = process.env,
	maxRetries = 4, baseDelayMs = 2000, maxDelayMs = 60000, sleep,
}) {
	const childEnv = { ...env };
	delete childEnv.NAN_API_KEY;
	async function once(messages) {
		const system = messages.find((m) => m.role === "system")?.content ?? "";
		const user = messages.find((m) => m.role === "user")?.content ?? "";
		const result = await runPi(command, piArgs({ model, system, user, jsonMode }), { timeoutMs, env: childEnv });
		if (result.spawnError) {
			const missing = result.spawnError.code === "ENOENT";
			throw new JudgeError(`pi judge failed: ${missing ? "pi_not_found" : "spawn_failed"}`, { code: missing ? "pi_not_found" : "spawn_failed" });
		}
		if (result.timedOut) throw new JudgeError(`pi judge failed: timeout after ${timeoutMs} ms`, { code: "timeout", retryable: true });
		if (result.code !== 0) throw failure(result.stderr, result.code ?? result.signal);
		if (!jsonMode) {
			if (!result.stdout.trim()) throw new JudgeError("pi judge failed: no_reply", { code: "no_reply", retryable: true });
			return { content: result.stdout, usage: null };
		}
		const message = lastAssistantMessage(result.stdout);
		if (!message) throw new JudgeError("pi judge failed: no_reply", { code: "no_reply", retryable: true });
		if (message.stopReason === "error" || message.stopReason === "aborted") throw failure(`${message.errorMessage ?? ""}\n${result.stderr}`);
		const content = (message.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("");
		return { content, usage: usageOf(message.usage) };
	}
	return withRetries(once, { maxRetries, baseDelayMs, maxDelayMs, ...(sleep ? { sleep } : {}) });
}
