// OpenAI-compatible chat-completions judge on NaN Builders. The key comes only
// from the NAN_API_KEY environment variable; it is never logged. Errors carry
// the HTTP status and at most a short provider code, never the response body.

export const DEFAULT_JUDGE_URL = "https://api.nan.builders/v1/chat/completions";
export const DEFAULT_JUDGE_MODEL = "nan/mimo-v2.6-flash";

export function requireApiKey(env) {
	const key = env.NAN_API_KEY?.trim();
	if (!key) throw new Error("NAN_API_KEY is not set; live judging reads the key only from the environment (use --dry-run to forecast without it)");
	return key;
}

/** "nan/mimo-v2.6-flash" -> "mimo-v2.6-flash" (the provider prefix is local naming). */
export function apiModelName(model) {
	return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

const RETRYABLE = (status) => status === 429 || status >= 500;
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timedOut = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

/**
 * A judge call failure. `status` is the HTTP status (null when no error
 * response was received), `code` a short provider code when one was found,
 * `exhausted` true when a retryable failure outlived every retry.
 */
export class JudgeError extends Error {
	constructor(message, { status = null, code = null, retryable = false, exhausted = false, retryAfterMs = null, attempts = null } = {}) {
		super(message);
		this.name = "JudgeError";
		this.status = status;
		this.code = code;
		this.retryable = retryable;
		this.exhausted = exhausted;
		this.retryAfterMs = retryAfterMs;
		this.attempts = attempts;
	}
}

function retryAfter(header) {
	if (header === null) return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const SHORT_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

/** A short machine code from an error body (`error.code`, `error.type` or `code`); never the message. */
function providerCode(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	const code = String(data?.error?.code ?? data?.error?.type ?? data?.code ?? "");
	return SHORT_CODE.test(code) ? code : null;
}

/**
 * Returns judge(messages) -> { content, usage: {promptTokens, completionTokens}, attempts }.
 * Retries 429, 5xx, network errors, request and body-read timeouts, and
 * truncated or invalid JSON bodies with exponential backoff (Retry-After
 * honored), at most `maxRetries` times; other statuses fail at once. The final
 * error is a JudgeError; `exhausted` marks a retryable failure that outlived
 * every retry (the batch circuit breaker counts those).
 */
export function createNanJudge({
	model = DEFAULT_JUDGE_MODEL, apiKey, url = DEFAULT_JUDGE_URL, jsonMode = true, timeoutMs = 120000,
	maxRetries = 4, baseDelayMs = 2000, maxDelayMs = 60000, fetchImpl = fetch, sleep = realSleep,
}) {
	const body = (messages) => JSON.stringify({
		model: apiModelName(model),
		messages,
		temperature: 0,
		...(jsonMode ? { response_format: { type: "json_object" } } : {}),
	});
	async function once(messages) {
		let response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: body(messages),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new JudgeError(timedOut(error) ? `judge request timed out after ${timeoutMs} ms` : `judge request failed: ${error?.cause?.code ?? error?.message ?? "network error"}`, { retryable: true });
		}
		// The timeout signal also covers the body read.
		let text;
		try {
			text = await response.text();
		} catch (error) {
			throw new JudgeError(timedOut(error) ? `judge response body timed out after ${timeoutMs} ms` : `judge response body read failed: ${error?.cause?.code ?? error?.name ?? "error"}`, { retryable: true });
		}
		if (!response.ok) {
			const code = providerCode(text);
			throw new JudgeError(`judge HTTP ${response.status}${code ? ` (${code})` : ""}`, { status: response.status, code, retryable: RETRYABLE(response.status), retryAfterMs: retryAfter(response.headers.get("retry-after")) });
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new JudgeError("judge response body is not valid JSON (truncated or malformed)", { retryable: true });
		}
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new JudgeError("judge response has no message content");
		return { content, usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 } };
	}
	return withRetries(once, { maxRetries, baseDelayMs, maxDelayMs, sleep });
}

/**
 * Wraps one judge call (messages -> reply, throwing JudgeError) with the
 * shared retry policy: retryable errors are retried with exponential backoff
 * (Retry-After honored) at most `maxRetries` times; the final error is a
 * JudgeError whose `exhausted` marks a retryable failure that outlived every
 * retry (the batch circuit breaker counts those). Used by every backend.
 */
export function withRetries(once, { maxRetries = 4, baseDelayMs = 2000, maxDelayMs = 60000, sleep = realSleep } = {}) {
	return async function judge(messages) {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return { ...(await once(messages)), attempts: attempt };
			} catch (error) {
				if (!error.retryable || attempt > maxRetries) {
					const exhausted = error.retryable === true;
					const message = !exhausted ? error.message : error.status ? `${error.message} after ${attempt} attempts` : `${error.message}; gave up after ${attempt} attempts`;
					throw new JudgeError(message, { status: error.status ?? null, code: error.code ?? null, retryable: error.retryable === true, exhausted, attempts: attempt });
				}
				const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
				await sleep(Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)));
			}
		}
	};
}
