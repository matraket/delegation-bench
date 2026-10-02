// Grading pipeline: collect answers from runs, judge them blind (cached,
// bounded concurrency), score, and join run metadata after judging.
import { discoverRuns, loadSession } from "../report/runs.mjs";
import { median, sum } from "../report/stats.mjs";
import { cacheKey } from "./cache.mjs";
import { answerKey, extractAnswers } from "./extract.mjs";
import { mapLimit } from "./pool.mjs";
import { PROMPT_VERSION, buildJudgeMessages, estimateTokens } from "./prompt.mjs";
import { JudgmentError, parseJudgment } from "./validate.mjs";
import { scoreJudgment } from "./score.mjs";

/** Attempts per answer when the judge reply fails validation. */
export const INVALID_ATTEMPTS = 2;

/** Consecutive answers whose judge call failed after every retry before the batch stops. */
export const DEFAULT_ABORT_AFTER = 3;

/** The judge endpoint keeps failing (quota, outage): the batch stops; cached judgments survive. */
export class JudgeAbortError extends Error {
	constructor(failures, lastError) {
		super(`judge endpoint failing: ${failures} consecutive answers failed after every retry (last: ${lastError}); stopped the batch. Judgments already made are cached; rerun to resume.`);
		this.name = "JudgeAbortError";
	}
}

// unreportedCalls: calls whose backend reported no token usage (for example pi in text mode).
const zeroUsage = () => ({ promptTokens: 0, completionTokens: 0, calls: 0, unreportedCalls: 0 });

/** Batch of a run id: everything before the last `-NN-` sequence number. */
export function batchOf(runId) {
	return /^(.*)-\d{2}-/.exec(runId)?.[1] ?? runId;
}

/**
 * Every user-turn answer of the matching runs, with its key. Runs whose
 * manifest status is not "completed" are skipped (`skippedRuns`). Turns map to
 * keys by position, so each mapped turn's sent prompt must equal its key's
 * prompt (and the manifest's planned prompt when recorded); one mismatch skips
 * the whole run (`misaligned`) so no answer is graded against the wrong key.
 * Unknown turn ids are reported (`unmapped`), not graded.
 */
export async function collectAnswers({ runsRoot, selectors, keyIndex }) {
	const seen = new Set();
	const answers = [];
	const unmapped = [];
	const misaligned = [];
	const skippedRuns = [];
	for (const selector of selectors) {
		for (const found of await discoverRuns(runsRoot, selector)) {
			if (seen.has(found.dir)) continue;
			seen.add(found.dir);
			if (found.manifest.status !== "completed") {
				skippedRuns.push({ runId: found.meta.runId, status: found.manifest.status ?? null });
				continue;
			}
			const run = await loadSession(found);
			const runAnswers = [];
			const runUnmapped = [];
			let mismatch = null;
			for (const extracted of extractAnswers(run)) {
				const key = extracted.turnId ? keyIndex.get(extracted.turnId) : undefined;
				if (!key) {
					runUnmapped.push({ runId: run.meta.runId, turnIndex: extracted.turnIndex, turnId: extracted.turnId });
					continue;
				}
				if (extracted.prompt !== key.prompt || extracted.promptMatches === false) {
					mismatch = { runId: run.meta.runId, turnIndex: extracted.turnIndex, turnId: extracted.turnId };
					break;
				}
				runAnswers.push({ batch: batchOf(run.meta.runId), meta: run.meta, ...extracted, answerKey: answerKey(extracted.turnId, extracted.answer), key });
			}
			if (mismatch) {
				misaligned.push(mismatch);
				continue;
			}
			answers.push(...runAnswers);
			unmapped.push(...runUnmapped);
		}
	}
	return { answers, unmapped, misaligned, skippedRuns };
}

const judgeInput = (a) => ({ prompt: a.key.prompt, answer: a.answer, facts: a.key.facts, forbidden: a.key.forbidden });
const keyOf = (a, judgeModel) => cacheKey({ turnId: a.turnId, answer: a.answer, key: a.key, judgeModel, promptVersion: PROMPT_VERSION });

async function judgeOne(answer, { judge, judgeModel, cache }) {
	const key = keyOf(answer, judgeModel);
	const hit = await cache.get(key);
	// The original call's usage was counted when it was made; a hit costs nothing now.
	if (hit) return { judgment: hit.judgment, usage: zeroUsage(), source: "cache" };
	const messages = buildJudgeMessages(judgeInput(answer));
	const usage = zeroUsage();
	let lastError = null;
	for (let attempt = 1; attempt <= INVALID_ATTEMPTS; attempt += 1) {
		let reply;
		try {
			reply = await judge(messages);
		} catch (error) {
			return { judgment: null, usage, error: error.message, exhausted: error.exhausted === true, source: "judge" };
		}
		usage.promptTokens += reply.usage?.promptTokens ?? 0;
		usage.completionTokens += reply.usage?.completionTokens ?? 0;
		usage.calls += 1;
		if (!reply.usage) usage.unreportedCalls += 1;
		try {
			const judgment = parseJudgment(reply.content, answer.key);
			const value = { judgment, usage, raw: reply.content, judgeModel, promptVersion: PROMPT_VERSION, judgedAt: new Date().toISOString() };
			await cache.set(key, value);
			return { judgment, usage, source: "judge" };
		} catch (error) {
			if (!(error instanceof JudgmentError)) throw error;
			lastError = error.message;
		}
	}
	return { judgment: null, usage, error: lastError, source: "judge" };
}

/** Run metadata joined after judging; the judge never saw any of it. */
function record(answer, outcome, judgeModel) {
	const scored = outcome.judgment ? scoreJudgment(outcome.judgment) : null;
	const { meta } = answer;
	return {
		answerKey: answer.answerKey,
		turnId: answer.turnId,
		questionId: answer.key.questionId,
		size: answer.key.size,
		followup: answer.key.followup,
		// source: "judge" (called now), "cache" (disk hit), "dedupe" (shared another answer's call) or "skipped".
		judge: { model: judgeModel, promptVersion: PROMPT_VERSION, source: outcome.source },
		skipped: outcome.skipped ?? null,
		error: outcome.error ?? null,
		facts: outcome.judgment?.facts ?? null,
		forbidden: outcome.judgment?.forbidden ?? null,
		language: outcome.judgment?.language ?? null,
		score: outcome.skipped ? 0 : scored?.score ?? null,
		supported: outcome.skipped ? 0 : scored?.supported ?? null,
		totalFacts: answer.key.facts.length,
		forbiddenPresent: scored?.forbiddenPresent ?? [],
		fullyCorrect: outcome.skipped ? false : scored?.fullyCorrect ?? null,
		usage: outcome.usage ?? zeroUsage(),
		batch: answer.batch,
		runId: meta.runId,
		arm: meta.arm,
		model: meta.model,
		replicate: meta.replicate,
		kind: meta.kind,
		turnIndex: answer.turnIndex,
		turnStatus: answer.turnStatus,
		answerChars: answer.answer.length,
	};
}

/**
 * Judge every answer. Stops the batch with a JudgeAbortError after
 * `abortAfter` consecutive answers whose call failed after every retry; any
 * other judge outcome resets that count.
 */
export async function gradeAnswers(answers, { judge, judgeModel, cache, concurrency = 2, abortAfter = DEFAULT_ABORT_AFTER, onProgress = () => {} }) {
	let done = 0;
	let failures = 0;
	// Identical answers to the same turn share one judge call, even when in flight together.
	const inflight = new Map();
	const shared = async (answer) => {
		const key = keyOf(answer, judgeModel);
		if (inflight.has(key)) {
			// A copy shares the verdict or the error, never the usage, and does not feed the breaker.
			const first = await inflight.get(key);
			return { judgment: first.judgment, error: first.error ?? null, usage: zeroUsage(), source: first.source === "cache" ? "cache" : "dedupe" };
		}
		const pending = judgeOne(answer, { judge, judgeModel, cache });
		inflight.set(key, pending);
		const outcome = await pending;
		if (outcome.exhausted) {
			failures += 1;
			if (failures >= abortAfter) throw new JudgeAbortError(failures, outcome.error);
		} else if (outcome.source === "judge") {
			failures = 0;
		}
		return outcome;
	};
	return mapLimit(answers, concurrency, async (answer) => {
		const outcome = answer.answer.trim()
			? await shared(answer)
			: { judgment: null, skipped: "empty-answer", source: "skipped" };
		done += 1;
		onProgress(done, answers.length);
		return record(answer, outcome, judgeModel);
	});
}

/** Answers per batch, cache hits and an estimate of judge prompt tokens; no judge call. */
export async function forecast(answers, { judgeModel, cache }) {
	const byBatch = new Map();
	const planned = new Set();
	for (const answer of answers) {
		const b = byBatch.get(answer.batch) ?? { batch: answer.batch, runs: new Set(), turns: 0, answers: 0, emptyAnswers: 0, cached: 0, duplicates: 0, toJudge: 0, estPromptTokens: 0, estOutputTokens: 0 };
		byBatch.set(answer.batch, b);
		b.runs.add(answer.meta.runId);
		b.turns += 1;
		if (!answer.answer.trim()) {
			b.emptyAnswers += 1;
			continue;
		}
		b.answers += 1;
		const key = keyOf(answer, judgeModel);
		if (await cache.get(key)) {
			b.cached += 1;
			continue;
		}
		if (planned.has(key)) {
			b.duplicates += 1;
			continue;
		}
		planned.add(key);
		b.toJudge += 1;
		b.estPromptTokens += estimateTokens(buildJudgeMessages(judgeInput(answer)));
		// Visible JSON only (about 12 tokens per id plus framing); reasoning tokens are not included.
		b.estOutputTokens += 12 * (answer.key.facts.length + answer.key.forbidden.length) + 20;
	}
	const batches = [...byBatch.values()].map((b) => ({ ...b, runs: b.runs.size }));
	const total = {};
	for (const field of ["runs", "turns", "answers", "emptyAnswers", "cached", "duplicates", "toJudge", "estPromptTokens", "estOutputTokens"]) total[field] = sum(batches.map((b) => b[field]));
	return { batches, total };
}

/** Per batch x model x arm: median and mean score, fully correct share, forbidden claims, languages. */
export function summarize(records) {
	const groups = new Map();
	for (const r of records) {
		const id = JSON.stringify([r.batch, r.model, r.arm]);
		if (!groups.has(id)) groups.set(id, []);
		groups.get(id).push(r);
	}
	return [...groups.values()].map((rs) => {
		// Scored: judged answers plus empty answers (score 0). Graded: judged answers only.
		const scored = rs.filter((r) => r.score !== null && !r.error);
		const graded = scored.filter((r) => !r.skipped);
		const scores = scored.map((r) => r.score);
		return {
			batch: rs[0].batch,
			model: rs[0].model,
			arm: rs[0].arm,
			answers: rs.length,
			graded: graded.length,
			errors: rs.filter((r) => r.error).length,
			emptyAnswers: rs.filter((r) => r.skipped === "empty-answer").length,
			medianScore: median(scores),
			meanScore: scores.length ? sum(scores) / scores.length : null,
			fullyCorrectShare: scored.length ? scored.filter((r) => r.fullyCorrect).length / scored.length : null,
			forbiddenClaims: sum(scored.map((r) => r.forbiddenPresent.length)),
			answersWithForbidden: scored.filter((r) => r.forbiddenPresent.length > 0).length,
			language: {
				en: rs.filter((r) => r.language === "en").length,
				es: rs.filter((r) => r.language === "es").length,
				other: rs.filter((r) => r.language === "other").length,
				none: rs.filter((r) => r.language === null).length,
			},
		};
	});
}
