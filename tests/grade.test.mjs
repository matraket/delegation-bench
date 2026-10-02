import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assistant, buildShortBatch, makeTempDir, toolResult, user, writeRun } from "./bench-fixture.mjs";
import { buildKeyIndex } from "../lib/grade/keys.mjs";
import { extractAnswers } from "../lib/grade/extract.mjs";
import { PROMPT_VERSION, buildJudgeMessages } from "../lib/grade/prompt.mjs";
import { JudgmentError, parseJudgment } from "../lib/grade/validate.mjs";
import { scoreJudgment } from "../lib/grade/score.mjs";
import { CACHE_KEY_VERSION, cacheKey, createCache } from "../lib/grade/cache.mjs";
import { JudgeError, apiModelName, createNanJudge, requireApiKey } from "../lib/grade/judge.mjs";
import { mapLimit } from "../lib/grade/pool.mjs";
import { JudgeAbortError, batchOf, collectAnswers, forecast, gradeAnswers, summarize } from "../lib/grade/run.mjs";
import { computeAgreement, sampleBlind } from "../lib/grade/sample.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../grade.mjs", import.meta.url));

const SET = {
	id: "set",
	questions: [
		{
			id: "q-small", size: "small", prompt: "small question",
			key: { facts: [{ id: "f1", text: "It draws 8 cells.", evidence: ["a.ts:1"] }, { id: "f2", text: "It uses two glyphs.", evidence: ["a.ts:2"] }], forbidden: [{ id: "x1", text: "It draws 10 cells." }] },
			followup: { prompt: "small followup", key: { facts: [{ id: "f1", text: "One cell is filled.", evidence: ["a.ts:3"] }] } },
		},
		{
			id: "q-large", size: "large", prompt: "large question",
			key: { facts: [{ id: "f1", text: "The launcher picks a home.", evidence: ["b.ts:1"] }] },
			followup: { prompt: "large followup", key: { facts: [{ id: "f1", text: "It requires pi 0.99.", evidence: ["b.ts:2"] }], forbidden: [{ id: "x1", text: "No check." }] } },
		},
	],
};

async function fixture() {
	const root = await makeTempDir("grade-");
	const runs = join(root, "runs");
	await buildShortBatch(runs);
	const setPath = join(root, "set.json");
	await writeFile(setPath, JSON.stringify(SET));
	return { root, runs, setPath, keyIndex: buildKeyIndex(SET) };
}

/** Judge stub: every fact supported, nothing forbidden, English. */
function perfectJudge(calls = []) {
	return async (messages) => {
		calls.push(messages);
		const user = messages[1].content;
		const facts = [...user.matchAll(/^- (f\d+):/gm)].map((m) => ({ id: m[1], supported: true }));
		const forbidden = [...user.matchAll(/^- (x\d+):/gm)].map((m) => ({ id: m[1], present: false }));
		return { content: JSON.stringify({ facts, forbidden, language: "en" }), usage: { promptTokens: 100, completionTokens: 20 } };
	};
}

test("extractAnswers takes the last non-empty assistant text of each user turn and maps turn ids by order", async () => {
	const answers = extractAnswers({
		manifest: { turns: [{ id: "q-small", status: "settled", prompt: "p1" }, { id: "q-small-followup", status: "aborted", prompt: "p2" }] },
		entries: [user("p1"), assistant("draft"), assistant(null, { tools: 1 }), toolResult(10), assistant("final answer"), assistant(" "), user("p2"), assistant("")],
	});
	assert.deepEqual(answers, [
		{ turnId: "q-small", turnIndex: 0, turnStatus: "settled", prompt: "p1", answer: "final answer", promptMatches: true },
		{ turnId: "q-small-followup", turnIndex: 1, turnStatus: "aborted", prompt: "p2", answer: "", promptMatches: true },
	]);
});

test("buildKeyIndex maps <id> and <id>-followup to their prompt and key", () => {
	const index = buildKeyIndex(SET);
	const main = index.get("q-small");
	const follow = index.get("q-small-followup");
	assert.equal(main.prompt, SET.questions[0].prompt);
	assert.deepEqual(main.facts.map((f) => f.id), ["f1", "f2"]);
	assert.deepEqual(main.forbidden.map((f) => f.id), ["x1"]);
	assert.equal(main.followup, false);
	assert.equal(follow.prompt, "small followup");
	assert.deepEqual(follow.forbidden, [], "a follow-up without forbidden claims gets an empty list");
	assert.equal(follow.followup, true);
	assert.equal(follow.questionId, "q-small");
	assert.equal(follow.size, "small");
	assert.equal(index.get("unknown"), undefined);
});

test("the judge prompt is blind: only question, answer, facts and forbidden claims", () => {
	const item = {
		prompt: "What does the small thing do?", answer: "It draws 8 cells.",
		facts: SET.questions[0].key.facts, forbidden: SET.questions[0].key.forbidden,
		arm: "delegate", model: "nan/glm5.3-flash", runId: "pilot-01-07-s2-gauge-delegate", nan: 330375, batch: "pilot-01",
	};
	const messages = buildJudgeMessages(item);
	const text = JSON.stringify(messages);
	for (const leak of ["delegate", "glm5.3", "pilot-01", "330375", "evidence", "a.ts"]) assert.ok(!text.includes(leak), `prompt leaks ${leak}`);
	for (const needed of ["What does the small thing do?", "It draws 8 cells.", "f1", "It uses two glyphs.", "x1", "It draws 10 cells."]) assert.ok(text.includes(needed), `prompt misses ${needed}`);
	assert.equal(messages[0].role, "system");
	assert.equal(messages[1].role, "user");
	assert.match(PROMPT_VERSION, /^grade-v\d+$/);
});

test("parseJudgment accepts a complete strict response and rejects malformed ones", () => {
	const key = { facts: [{ id: "f1" }, { id: "f2" }], forbidden: [{ id: "x1" }] };
	const ok = { facts: [{ id: "f2", supported: false }, { id: "f1", supported: true }], forbidden: [{ id: "x1", present: true }], language: "es" };
	assert.deepEqual(parseJudgment(JSON.stringify(ok), key), {
		facts: [{ id: "f1", supported: true }, { id: "f2", supported: false }], forbidden: [{ id: "x1", present: true }], language: "es",
	});
	assert.deepEqual(parseJudgment("```json\n" + JSON.stringify(ok) + "\n```", key).language, "es", "a single json code fence is tolerated");
	const bad = [
		"not json",
		"{\"facts\": [",
		JSON.stringify({ ...ok, facts: [{ id: "f1", supported: true }] }),
		JSON.stringify({ ...ok, facts: [...ok.facts, { id: "f3", supported: true }] }),
		JSON.stringify({ ...ok, facts: [{ id: "f1", supported: "yes" }, { id: "f2", supported: false }] }),
		JSON.stringify({ ...ok, facts: [{ id: "f1", supported: true }, { id: "f1", supported: false }] }),
		JSON.stringify({ ...ok, forbidden: [] }),
		JSON.stringify({ ...ok, language: "fr" }),
		JSON.stringify([ok]),
		"Here it is: " + JSON.stringify(ok),
	];
	for (const content of bad) assert.throws(() => parseJudgment(content, key), JudgmentError, content);
});

test("scoreJudgment: supported share, forbidden flags and full correctness", () => {
	const judgment = { facts: [{ id: "f1", supported: true }, { id: "f2", supported: false }, { id: "f3", supported: true }, { id: "f4", supported: true }], forbidden: [{ id: "x1", present: false }, { id: "x2", present: true }], language: "en" };
	assert.deepEqual(scoreJudgment(judgment), { supported: 3, totalFacts: 4, score: 0.75, forbiddenPresent: ["x2"], fullyCorrect: false });
	const perfect = { facts: [{ id: "f1", supported: true }], forbidden: [], language: "en" };
	assert.deepEqual(scoreJudgment(perfect), { supported: 1, totalFacts: 1, score: 1, forbiddenPresent: [], fullyCorrect: true });
	const forbiddenOnly = { facts: [{ id: "f1", supported: true }], forbidden: [{ id: "x1", present: true }], language: "en" };
	assert.equal(scoreJudgment(forbiddenOnly).fullyCorrect, false, "a forbidden claim breaks full correctness");
});

test("collectAnswers maps every turn of the batch to its key and tags the batch from the run id", async () => {
	const { runs, keyIndex } = await fixture();
	const { answers, unmapped } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	assert.equal(answers.length, 8);
	assert.deepEqual(unmapped, []);
	const empty = answers.find((a) => a.meta.runId === "fx-01-04-q-large-delegate" && a.turnId === "q-large-followup");
	assert.equal(empty.answer, "");
	assert.equal(answers[0].batch, "fx-01");
	assert.equal(batchOf("pilot-02-deepseek-v4-flash-01-l2-prompt-history-inline"), "pilot-02-deepseek-v4-flash");
	assert.equal(batchOf("long-01-03-delegate-r3"), "long-01");
	assert.equal(batchOf("smoke-01"), "smoke-01");
});

test("gradeAnswers judges each answer once, joins run metadata after judging, and reuses the cache", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	const cache = createCache(join(root, "cache"));
	const calls = [];
	const records = await gradeAnswers(answers, { judge: perfectJudge(calls), judgeModel: "nan/mimo-v2.6-flash", cache, concurrency: 1 });
	// 8 answers: the empty one is not judged, and both q-large main answers are
	// the same text, so the second shares the first one's call (deduplicated).
	assert.equal(calls.length, 6);
	assert.deepEqual(records.map((r) => r.judge.source).sort(), ["dedupe", "judge", "judge", "judge", "judge", "judge", "judge", "skipped"]);
	const dedupe = records.find((r) => r.judge.source === "dedupe");
	assert.deepEqual(dedupe.usage, { promptTokens: 0, completionTokens: 0, calls: 0, unreportedCalls: 0 });
	assert.equal(dedupe.error, null);
	const parallel = [];
	const parallelRecords = await gradeAnswers(answers, { judge: perfectJudge(parallel), judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "cache-parallel")), concurrency: 8 });
	assert.equal(parallel.length, 6, "identical answers in flight together share one call");
	assert.equal(parallelRecords.filter((r) => r.judge.source === "dedupe").length, 1, "an in-flight duplicate is labelled dedupe");
	assert.equal(parallelRecords.filter((r) => r.judge.source === "cache").length, 0, "an in-flight duplicate is not a disk cache hit");
	for (const messages of calls) assert.ok(!JSON.stringify(messages).includes("fx-01"), "run ids never reach the judge");
	const rec = records.find((r) => r.runId === "fx-01-01-q-small-inline" && r.turnId === "q-small");
	assert.equal(rec.arm, "inline");
	assert.equal(rec.model, "nan/test-model");
	assert.equal(rec.score, 1);
	assert.equal(rec.fullyCorrect, true);
	assert.deepEqual(rec.usage, { promptTokens: 100, completionTokens: 20, calls: 1, unreportedCalls: 0 });
	assert.equal(rec.judge.source, "judge");
	const empty = records.find((r) => r.answerChars === 0);
	assert.equal(empty.skipped, "empty-answer");
	assert.equal(empty.score, 0);
	assert.equal(empty.judge.source, "skipped");

	const again = [];
	const second = await gradeAnswers(answers, { judge: perfectJudge(again), judgeModel: "nan/mimo-v2.6-flash", cache, concurrency: 2 });
	assert.equal(again.length, 0, "a cache hit avoids a second judge call");
	assert.equal(second.find((r) => r.turnId === "q-small" && r.arm === "inline").judge.source, "cache");
	assert.ok(second.every((r) => r.usage.calls === 0 && r.usage.promptTokens === 0 && r.usage.completionTokens === 0), "a disk cache hit does not replay the original call's usage");

	const otherModel = [];
	await gradeAnswers(answers.slice(0, 1), { judge: perfectJudge(otherModel), judgeModel: "nan/other", cache, concurrency: 1 });
	assert.equal(otherModel.length, 1, "the judge model is part of the cache key");
});

test("an invalid judge response is retried once, then recorded as an error without stopping the batch", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-01-"], keyIndex });
	let calls = 0;
	const judge = async () => {
		calls += 1;
		return { content: "I think it is fine", usage: { promptTokens: 10, completionTokens: 5 } };
	};
	const records = await gradeAnswers(answers, { judge, judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "cache")), concurrency: 1 });
	assert.equal(calls, 4, "two answers, two attempts each");
	assert.ok(records.every((r) => /invalid judge response/.test(r.error)));
	assert.ok(records.every((r) => r.score === null));
	assert.deepEqual(records[0].usage, { promptTokens: 20, completionTokens: 10, calls: 2, unreportedCalls: 0 });
});

test("mapLimit never runs more than the limit at once", async () => {
	let active = 0;
	let peak = 0;
	const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (x) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
		return x * 2;
	});
	assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
	assert.equal(peak, 2);
});

test("gradeAnswers respects the concurrency bound with a slow judge", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	let active = 0;
	let peak = 0;
	const inner = perfectJudge();
	const judge = async (messages) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 10));
		active -= 1;
		return inner(messages);
	};
	await gradeAnswers(answers, { judge, judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "cache")), concurrency: 2 });
	assert.equal(peak, 2);
});

test("summarize reports median score, fully correct share, forbidden claims and languages per batch and arm", () => {
	const base = { batch: "b", model: "m", skipped: null, error: null, language: "en", forbiddenPresent: [] };
	const records = [
		{ ...base, arm: "inline", score: 1, fullyCorrect: true },
		{ ...base, arm: "inline", score: 0.5, fullyCorrect: false, forbiddenPresent: ["x1"], language: "es" },
		{ ...base, arm: "inline", score: 0, fullyCorrect: false, skipped: "empty-answer", language: null },
		{ ...base, arm: "delegate", score: null, fullyCorrect: null, error: "boom", language: null },
	];
	const summary = summarize(records);
	const inline = summary.find((s) => s.arm === "inline");
	assert.deepEqual(inline, { batch: "b", model: "m", arm: "inline", answers: 3, graded: 2, errors: 0, emptyAnswers: 1, medianScore: 0.5, meanScore: 0.5, fullyCorrectShare: 1 / 3, forbiddenClaims: 1, answersWithForbidden: 1, language: { en: 1, es: 1, other: 0, none: 1 } });
	assert.equal(summary.find((s) => s.arm === "delegate").errors, 1);
});

test("forecast counts answers per batch and estimates judge prompt tokens without judging", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	const result = await forecast(answers, { judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "cache")) });
	assert.equal(result.batches.length, 1);
	const b = result.batches[0];
	assert.deepEqual([b.batch, b.runs, b.turns, b.answers, b.emptyAnswers, b.cached, b.duplicates, b.toJudge], ["fx-01", 4, 8, 7, 1, 0, 1, 6]);
	assert.ok(b.estPromptTokens > 0);
	assert.equal(result.total.toJudge, 6);
});

test("createNanJudge retries 429 and 5xx with backoff, then succeeds; sends temperature 0 and JSON mode", async () => {
	const statuses = [429, 503, 200];
	const seen = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			seen.push({ auth: req.headers.authorization, body: JSON.parse(body), url: req.url });
			const status = statuses.shift();
			res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "0" } : {}) });
			res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 321, completion_tokens: 12 } }) : "{\"error\":\"busy\"}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const sleeps = [];
		const judge = createNanJudge({
			model: "nan/mimo-v2.6-flash", apiKey: "test-key", url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
			baseDelayMs: 10, maxRetries: 3, sleep: async (ms) => { sleeps.push(ms); },
		});
		const result = await judge([{ role: "user", content: "hi" }]);
		assert.equal(result.content, "{\"ok\":true}");
		assert.deepEqual(result.usage, { promptTokens: 321, completionTokens: 12 });
		assert.equal(result.attempts, 3);
		assert.equal(seen.length, 3);
		assert.equal(seen[0].auth, "Bearer test-key");
		assert.equal(seen[0].body.model, "mimo-v2.6-flash");
		assert.equal(seen[0].body.temperature, 0);
		assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
		assert.equal(sleeps.length, 2);
	} finally {
		server.close();
	}
});

test("createNanJudge gives up after the retry cap and never puts the key in the error", async () => {
	const server = createServer((req, res) => {
		res.writeHead(500);
		res.end("upstream down");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		let calls = 0;
		const judge = createNanJudge({
			model: "nan/mimo-v2.6-flash", apiKey: "secret-key-123", url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
			baseDelayMs: 1, maxRetries: 2, sleep: async () => { calls += 1; },
		});
		await assert.rejects(judge([{ role: "user", content: "hi" }]), (error) => {
			assert.match(error.message, /HTTP 500 after 3 attempts/);
			assert.ok(!error.message.includes("secret-key-123"));
			return true;
		});
		assert.equal(calls, 2);
	} finally {
		server.close();
	}
});

test("createNanJudge does not retry a 400 and times out a hung request", async () => {
	let hits = 0;
	const server = createServer((req, res) => {
		hits += 1;
		if (req.url.endsWith("/hang")) return;
		res.writeHead(400);
		res.end("bad request");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const judge400 = createNanJudge({ model: "m", apiKey: "k", url: `${base}/bad`, baseDelayMs: 1, maxRetries: 3, sleep: async () => {} });
		await assert.rejects(judge400([]), /HTTP 400/);
		assert.equal(hits, 1);
		const hung = createNanJudge({ model: "m", apiKey: "k", url: `${base}/hang`, timeoutMs: 50, baseDelayMs: 1, maxRetries: 1, sleep: async () => {} });
		await assert.rejects(hung([]), /timed out after 50 ms/);
		assert.equal(hits, 3, "one retry after the first timeout");
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("requireApiKey refuses a missing key; apiModelName strips the provider", () => {
	assert.throws(() => requireApiKey({}), /NAN_API_KEY is not set/);
	assert.throws(() => requireApiKey({ NAN_API_KEY: "  " }), /NAN_API_KEY is not set/);
	assert.equal(requireApiKey({ NAN_API_KEY: "abc" }), "abc");
	assert.equal(apiModelName("nan/mimo-v2.6-flash"), "mimo-v2.6-flash");
	assert.equal(apiModelName("mimo-v2.6-flash"), "mimo-v2.6-flash");
});

test("sampleBlind is seeded and blind; computeAgreement compares facts and scores", async () => {
	const { runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	const a = sampleBlind(answers, 3, 5139);
	const b = sampleBlind(answers, 3, 5139);
	assert.deepEqual(a, b, "same seed, same sample");
	assert.equal(a.entries.length, 3);
	const text = JSON.stringify(a);
	for (const leak of ["fx-01", "inline", "delegate", "test-model", "runId", "arm", "model"]) assert.ok(!text.includes(leak), `sample leaks ${leak}`);
	const entry = a.entries[0];
	assert.deepEqual(Object.keys(entry), ["sampleId", "turnId", "question", "answer", "facts", "forbidden", "language"]);
	assert.ok(entry.facts.every((f) => f.supported === null));

	const judged = a.entries.map((e) => ({ answerKey: e.sampleId, facts: e.facts.map((f) => ({ id: f.id, supported: true })), forbidden: e.forbidden.map((f) => ({ id: f.id, present: false })), language: "en", score: 1 }));
	const reference = { entries: a.entries.map((e, i) => ({ ...e, facts: e.facts.map((f, j) => ({ ...f, supported: !(i === 0 && j === 0) })), forbidden: e.forbidden.map((f) => ({ ...f, present: false })), language: "en" })) };
	const agreement = computeAgreement(judged, reference);
	const totalFacts = a.entries.reduce((n, e) => n + e.facts.length, 0);
	assert.equal(agreement.answers, 3);
	assert.equal(agreement.facts.compared, totalFacts);
	assert.equal(agreement.facts.agree, totalFacts - 1);
	assert.equal(agreement.disagreements.length, 1);
	assert.equal(agreement.language.agree, 3);
	assert.equal(typeof agreement.score.meanAbsDiff, "number");
});

async function cliFixture() {
	const f = await fixture();
	return { ...f, out: join(f.root, "grading") };
}

test("grade.mjs --dry-run prints counts and a forecast and makes no network call without a key", async () => {
	const { runs, setPath, out } = await cliFixture();
	let hits = 0;
	const server = createServer((req, res) => { hits += 1; res.end(); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const env = { ...process.env };
		delete env.NAN_API_KEY;
		const { stdout } = await run(process.execPath, [CLI, "--dry-run", "fx-01-", "--runs", runs, "--set", setPath, "--out", out, "--judge-url", `http://127.0.0.1:${server.address().port}/v1/chat/completions`], { env });
		assert.match(stdout, /fx-01 +4 runs +8 turns +7 answers +1 empty/);
		assert.match(stdout, /to judge 6/);
		assert.match(stdout, /est\. judge prompt tokens/);
		assert.match(stdout, /dry run: no judge call/);
		assert.equal(hits, 0);
	} finally {
		server.close();
	}
});

test("grade.mjs refuses live judging when NAN_API_KEY is missing, before any call", async () => {
	const { runs, setPath, out } = await cliFixture();
	let hits = 0;
	const server = createServer((req, res) => { hits += 1; res.end(); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const env = { ...process.env };
		delete env.NAN_API_KEY;
		await assert.rejects(run(process.execPath, [CLI, "fx-01-", "--runs", runs, "--set", setPath, "--out", out, "--judge-url", `http://127.0.0.1:${server.address().port}/v1/chat/completions`], { env }), (error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /NAN_API_KEY is not set/);
			return true;
		});
		assert.equal(hits, 0);
	} finally {
		server.close();
	}
});

test("grade.mjs grades against a fake server and writes grades.jsonl and a summary", async () => {
	const { runs, setPath, out } = await cliFixture();
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const userText = JSON.parse(body).messages[1].content;
			const facts = [...userText.matchAll(/^- (f\d+):/gm)].map((m) => ({ id: m[1], supported: m[1] === "f1" }));
			const forbidden = [...userText.matchAll(/^- (x\d+):/gm)].map((m) => ({ id: m[1], present: false }));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts, forbidden, language: "en" }) } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const env = { ...process.env, NAN_API_KEY: "fake" };
		const { stdout } = await run(process.execPath, [CLI, "fx-01-", "--runs", runs, "--set", setPath, "--out", out, "--judge-url", `http://127.0.0.1:${server.address().port}/v1/chat/completions`], { env });
		assert.match(stdout, /8 answers: 6 judged, 0 cached, 1 deduplicated, 1 empty, 0 errors/);
		const lines = (await readFile(join(out, "grades.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 8);
		const smallMain = lines.find((l) => l.turnId === "q-small" && l.arm === "inline");
		assert.equal(smallMain.score, 0.5);
		assert.ok(!JSON.stringify(lines).includes("fake"), "the key is never written");
		const summary = JSON.parse(await readFile(join(out, "summary.json"), "utf8"));
		assert.ok(summary.groups.some((g) => g.arm === "delegate"));
		assert.match(await readFile(join(out, "summary.md"), "utf8"), /\| fx-01 \| nan\/test-model \| inline \|/);
	} finally {
		server.close();
	}
});

test("grade.mjs --sample --export writes a blind file without a key or network", async () => {
	const { runs, setPath, out } = await cliFixture();
	const env = { ...process.env };
	delete env.NAN_API_KEY;
	const file = join(out, "sample.json");
	const { stdout } = await run(process.execPath, [CLI, "fx-01-", "--sample", "4", "--seed", "7", "--export", file, "--runs", runs, "--set", setPath, "--out", out], { env });
	assert.match(stdout, /exported 4 blind answers/);
	const sample = JSON.parse(await readFile(file, "utf8"));
	assert.equal(sample.entries.length, 4);
	assert.ok(!JSON.stringify(sample).includes("fx-01"));
});

test("grade.mjs --agreement compares a judge results file with a filled sample", async () => {
	const { runs, setPath, out } = await cliFixture();
	const file = join(out, "sample.json");
	await run(process.execPath, [CLI, "fx-01-", "--sample", "3", "--seed", "1", "--export", file, "--runs", runs, "--set", setPath, "--out", out]);
	const sample = JSON.parse(await readFile(file, "utf8"));
	for (const entry of sample.entries) {
		for (const fact of entry.facts) fact.supported = true;
		for (const claim of entry.forbidden) claim.present = false;
		entry.language = "en";
	}
	const reference = join(out, "reference.json");
	await writeFile(reference, JSON.stringify(sample));
	const judged = join(out, "judged.jsonl");
	await writeFile(judged, sample.entries.map((e) => JSON.stringify({ answerKey: e.sampleId, facts: e.facts.map(({ id }) => ({ id, supported: true })), forbidden: [], language: "en" })).join("\n"));
	const { stdout } = await run(process.execPath, [CLI, "--agreement", judged, reference]);
	const result = JSON.parse(stdout);
	assert.equal(result.answers, 3);
	assert.equal(result.facts.rate, 1);
});

// --- T7.2.1 hardening ---

const listen = async (handler) => {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
};
const okBody = (content = "{\"ok\":true}") => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

test("mapLimit stops the other workers from taking new items when one throws", async () => {
	const started = [];
	await assert.rejects(mapLimit(Array.from({ length: 10 }, (_, i) => i), 2, async (x) => {
		started.push(x);
		if (x === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			throw new Error("boom");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		return x;
	}), /boom/);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(started, [0, 1], "no item starts after a worker threw");
});

const exhausted = () => new JudgeError("judge HTTP 429 after 5 attempts", { status: 429, retryable: true, exhausted: true });

test("gradeAnswers aborts after N consecutive exhausted judge failures and keeps cached judgments for a rerun", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	const cache = createCache(join(root, "cache"));
	let calls = 0;
	const good = perfectJudge();
	const failing = async (messages) => {
		calls += 1;
		if (calls <= 2) return good(messages);
		throw exhausted();
	};
	await assert.rejects(gradeAnswers(answers, { judge: failing, judgeModel: "nan/mimo-v2.6-flash", cache, concurrency: 1, abortAfter: 3 }), (error) => {
		assert.ok(error instanceof JudgeAbortError);
		assert.match(error.message, /3 consecutive answers failed/);
		assert.match(error.message, /HTTP 429/);
		return true;
	});
	assert.equal(calls, 5, "two successes, then three failures, then nothing more");
	const rerun = [];
	const records = await gradeAnswers(answers, { judge: perfectJudge(rerun), judgeModel: "nan/mimo-v2.6-flash", cache, concurrency: 1 });
	assert.equal(rerun.length, 4, "the rerun judges only what the aborted batch did not cache");
	assert.equal(records.filter((r) => r.judge.source === "cache").length, 2);
});

test("gradeAnswers resets the breaker on success and does not trip on non-retryable errors", async () => {
	const { root, runs, keyIndex } = await fixture();
	const { answers } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	let calls = 0;
	const good = perfectJudge();
	const alternating = async (messages) => {
		calls += 1;
		if (calls % 2) throw exhausted();
		return good(messages);
	};
	const mixed = await gradeAnswers(answers, { judge: alternating, judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "c1")), concurrency: 1, abortAfter: 2 });
	assert.equal(mixed.filter((r) => r.error).length, 4, "three failed calls plus the deduplicated copy of one; never three in a row");
	const badRequest = async () => { throw new JudgeError("judge HTTP 400", { status: 400, retryable: false }); };
	const records = await gradeAnswers(answers, { judge: badRequest, judgeModel: "nan/mimo-v2.6-flash", cache: createCache(join(root, "c2")), concurrency: 8, abortAfter: 2 });
	assert.equal(records.filter((r) => r.error).length, 7);
	const copy = records.find((r) => r.judge.source === "dedupe");
	assert.ok(copy, "the duplicate answer shares the failed call");
	assert.match(copy.error, /HTTP 400/, "a deduplicated copy of a failed judgment is recorded as failed");
	assert.equal(copy.score, null);
});

test("collectAnswers skips a run whose user prompts do not match the keyed prompts", async () => {
	const { runs, keyIndex } = await fixture();
	await writeRun(runs, {
		runId: "fx-01-05-q-small-inline", arm: "inline", model: "nan/test-model",
		questions: { path: null, id: "set/short/q-small" },
		turns: [{ id: "q-small", durationMs: 1 }, { id: "q-small-followup", durationMs: 1 }],
		entries: [user("small followup"), assistant("Answer one."), user("small question"), assistant("Answer two.")],
		analysis: { nan: 1, api: 1, peak: 1, final: 1, input: 1, cacheRead: 1, output: 1 },
	});
	const { answers, misaligned } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	assert.equal(answers.length, 8, "no answer of the misaligned run is graded");
	assert.ok(answers.every((a) => a.meta.runId !== "fx-01-05-q-small-inline"));
	assert.deepEqual(misaligned.map((m) => [m.runId, m.turnIndex, m.turnId]), [["fx-01-05-q-small-inline", 0, "q-small"]]);
});

test("collectAnswers skips runs that are not completed and does not need analysis.json", async () => {
	const { runs, keyIndex } = await fixture();
	const failedDir = await writeRun(runs, {
		runId: "fx-01-06-q-small-delegate", arm: "delegate", model: "nan/test-model", status: "failed",
		questions: { path: null, id: "set/short/q-small" },
		turns: [{ id: "q-small", durationMs: 1 }],
		entries: [user("small question"), assistant("Partial.")],
		analysis: { nan: 1, api: 1, peak: 1, final: 1, input: 1, cacheRead: 1, output: 1 },
	});
	await rm(join(failedDir, "analysis.json"));
	await rm(join(runs, "fx-01-01-q-small-inline", "inline", "nan_test-model", "rep-1", "analysis.json"));
	const { answers, skippedRuns } = await collectAnswers({ runsRoot: runs, selectors: ["fx-01-"], keyIndex });
	assert.equal(answers.length, 8, "the completed run without analysis.json is still graded");
	assert.deepEqual(skippedRuns, [{ runId: "fx-01-06-q-small-delegate", status: "failed" }]);
});

test("cacheKey includes the question prompt and a cache key version", () => {
	const base = { turnId: "q", answer: "a", key: { prompt: "p1", facts: [{ id: "f1", text: "t" }], forbidden: [] }, judgeModel: "m", promptVersion: "grade-v1" };
	assert.notEqual(cacheKey(base), cacheKey({ ...base, key: { ...base.key, prompt: "p2" } }));
	assert.equal(cacheKey(base), cacheKey({ ...base }));
	assert.match(CACHE_KEY_VERSION, /^cache-v[2-9]/);
});

test("createNanJudge retries a body-read timeout and a truncated JSON body", async () => {
	let hits = 0;
	const { server, url } = await listen((req, res) => {
		hits += 1;
		req.resume();
		res.writeHead(200, { "content-type": "application/json" });
		if (hits === 1) return res.write("{\"choices\":"); // headers sent, body hangs
		if (hits === 2) return res.end("{\"choices\":[{\"mess"); // truncated body
		res.end(okBody());
	});
	try {
		const judge = createNanJudge({ model: "m", apiKey: "k", url, timeoutMs: 100, baseDelayMs: 1, maxRetries: 3, sleep: async () => {} });
		const result = await judge([{ role: "user", content: "hi" }]);
		assert.equal(result.attempts, 3);
		assert.equal(result.content, "{\"ok\":true}");
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("judge errors carry the HTTP status as a field and never the provider body", async () => {
	const { server, url } = await listen((req, res) => {
		req.resume();
		res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
		res.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "PROVIDER-SECRET-BODY quota for org-123" } }));
	});
	try {
		const judge = createNanJudge({ model: "m", apiKey: "secret-key-123", url, baseDelayMs: 1, maxRetries: 1, sleep: async () => {} });
		await assert.rejects(judge([]), (error) => {
			assert.ok(error instanceof JudgeError);
			assert.equal(error.status, 429);
			assert.equal(error.exhausted, true);
			assert.match(error.message, /HTTP 429/);
			assert.match(error.message, /rate_limit_exceeded/);
			assert.ok(!error.message.includes("PROVIDER-SECRET-BODY"));
			assert.ok(!error.message.includes("secret-key-123"));
			return true;
		});
	} finally {
		server.close();
	}
});

test("grade.mjs aborts on a sustained 429, exits non-zero, keeps prior grades and writes no provider body", async () => {
	const { runs, setPath, out } = await cliFixture();
	let hits = 0;
	const { server, url } = await listen((req, res) => {
		hits += 1;
		req.resume();
		res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
		res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "PROVIDER-SECRET-BODY" } }));
	});
	try {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(out, { recursive: true });
		await writeFile(join(out, "grades.jsonl"), "PRIOR\n");
		const env = { ...process.env, NAN_API_KEY: "fake" };
		await assert.rejects(run(process.execPath, [CLI, "fx-01-", "--runs", runs, "--set", setPath, "--out", out, "--judge-url", url, "--max-retries", "0", "--abort-after", "2", "--concurrency", "1"], { env }), (error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /2 consecutive answers failed/);
			assert.match(error.stderr, /rerun to resume/);
			assert.ok(!error.stderr.includes("PROVIDER-SECRET-BODY"));
			return true;
		});
		assert.equal(hits, 2, "the batch stops after two failed answers");
		assert.equal(await readFile(join(out, "grades.jsonl"), "utf8"), "PRIOR\n");
	} finally {
		server.close();
	}
});

test("grade.mjs records a failed answer without the provider body in grades.jsonl and the summary", async () => {
	const { runs, setPath, out } = await cliFixture();
	const { server, url } = await listen((req, res) => {
		req.resume();
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { code: "bad_request", message: "PROVIDER-SECRET-BODY" } }));
	});
	try {
		const env = { ...process.env, NAN_API_KEY: "fake" };
		await assert.rejects(run(process.execPath, [CLI, "fx-01-", "--runs", runs, "--set", setPath, "--out", out, "--judge-url", url], { env }), (error) => error.code === 2);
		for (const file of ["grades.jsonl", "summary.json", "summary.md"]) {
			const text = await readFile(join(out, file), "utf8");
			assert.ok(!text.includes("PROVIDER-SECRET-BODY"), `${file} holds the provider body`);
		}
		assert.match(await readFile(join(out, "grades.jsonl"), "utf8"), /HTTP 400 \(bad_request\)/);
	} finally {
		server.close();
	}
});

test("grade.mjs --dry-run reports misaligned and not-completed runs as skipped", async () => {
	const { runs, setPath, out } = await cliFixture();
	await writeRun(runs, {
		runId: "fx-01-05-q-small-inline", arm: "inline", model: "nan/test-model", status: "aborted",
		questions: { path: null, id: "set/short/q-small" }, turns: [{ id: "q-small", durationMs: 1 }],
		entries: [user("small question"), assistant("A.")], analysis: { nan: 1, api: 1, peak: 1, final: 1, input: 1, cacheRead: 1, output: 1 },
	});
	await writeRun(runs, {
		runId: "fx-01-06-q-small-inline", arm: "inline", model: "nan/test-model",
		questions: { path: null, id: "set/short/q-small" }, turns: [{ id: "q-small", durationMs: 1 }],
		entries: [user("something else"), assistant("A.")], analysis: { nan: 1, api: 1, peak: 1, final: 1, input: 1, cacheRead: 1, output: 1 },
	});
	const env = { ...process.env };
	delete env.NAN_API_KEY;
	const { stdout } = await run(process.execPath, [CLI, "--dry-run", "fx-01-", "--runs", runs, "--set", setPath, "--out", out], { env });
	assert.match(stdout, /skipped runs: 2 \(1 not completed, 1 misaligned\)/);
	assert.match(stdout, /fx-01-05-q-small-inline: status aborted/);
	assert.match(stdout, /fx-01-06-q-small-inline: turn 0 \(q-small\) prompt does not match the key/);
	assert.match(stdout, /fx-01 +4 runs +8 turns/);
});

test("grade.mjs --agreement accepts a JSONL file with exactly one record", async () => {
	const { runs, setPath, out } = await cliFixture();
	const file = join(out, "sample.json");
	await run(process.execPath, [CLI, "fx-01-", "--sample", "1", "--seed", "1", "--export", file, "--runs", runs, "--set", setPath, "--out", out]);
	const sample = JSON.parse(await readFile(file, "utf8"));
	const [entry] = sample.entries;
	for (const fact of entry.facts) fact.supported = true;
	await writeFile(join(out, "reference.json"), JSON.stringify(sample));
	await writeFile(join(out, "one.jsonl"), `${JSON.stringify({ answerKey: entry.sampleId, facts: entry.facts.map(({ id }) => ({ id, supported: true })), forbidden: [], language: "en" })}\n`);
	const { stdout } = await run(process.execPath, [CLI, "--agreement", join(out, "one.jsonl"), join(out, "reference.json")]);
	const result = JSON.parse(stdout);
	assert.equal(result.answers, 1);
	assert.equal(result.missingFromJudge, 0);
});
