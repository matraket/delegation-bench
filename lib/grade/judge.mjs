// OpenAI-compatible chat-completions judge on NaN Builders. The key comes only
// from the NAN_API_KEY environment variable; it is never logged, and errors
// carry only the HTTP status and a short slice of the response body.

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

class JudgeHttpError extends Error {
	constructor(message, { retryable, retryAfterMs = null }) {
		super(message);
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
	}
}

function retryAfter(header) {
	if (header === null) return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * Returns judge(messages) -> { content, usage: {promptTokens, completionTokens}, attempts }.
 * Retries 429, 5xx, network errors and timeouts with exponential backoff
 * (Retry-After honored), at most `maxRetries` times; other statuses fail at once.
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
			const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
			throw new JudgeHttpError(timedOut ? `judge request timed out after ${timeoutMs} ms` : `judge request failed: ${error?.cause?.code ?? error?.message ?? "network error"}`, { retryable: true });
		}
		if (!response.ok) {
			const text = (await response.text().catch(() => "")).slice(0, 300);
			throw new JudgeHttpError(`judge HTTP ${response.status}: ${text}`, { retryable: RETRYABLE(response.status), retryAfterMs: retryAfter(response.headers.get("retry-after")) });
		}
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new JudgeHttpError("judge response has no message content", { retryable: false });
		return { content, usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 } };
	}
	return async function judge(messages) {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return { ...(await once(messages)), attempts: attempt };
			} catch (error) {
				if (!error.retryable || attempt > maxRetries) {
					const status = /HTTP (\d+)/.exec(error.message)?.[1];
					const prefix = error.retryable && status ? `judge HTTP ${status} after ${attempt} attempts` : null;
					throw new Error(prefix ? `${prefix}: ${error.message}` : error.message);
				}
				const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
				await sleep(Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)));
			}
		}
	};
}
