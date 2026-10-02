// Judge backend through plain `pi` and judging a blind calibration sample.
// Every pi call goes to the fake executable in tests/fixtures/fake-pi-judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildShortBatch, makeTempDir } from "./bench-fixture.mjs";
import { buildKeyIndex } from "../lib/grade/keys.mjs";
import { PROMPT_VERSION, buildJudgeMessages } from "../lib/grade/prompt.mjs";
import { cacheKey, createCache } from "../lib/grade/cache.mjs";
import { JudgeError } from "../lib/grade/judge.mjs";
import { classifyPiFailure, createPiJudge, piArgs } from "../lib/grade/pi-judge.mjs";
import { defaultConcurrency, parseJudgeSpec } from "../lib/grade/backends.mjs";
import { JudgeAbortError, collectAnswers, gradeAnswers } from "../lib/grade/run.mjs";
import { sampleBlind, sampleToAnswers } from "../lib/grade/sample.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../grade.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi-judge/pi", import.meta.url));
const PI_JUDGE = "pi/openai-codex/gpt-6.1-sol";

const SET = {
	id: "set",
	questions: [
		{
			id: "q-small", size: "small", prompt: "small question",
			key: { facts: [{ id: "f1", text: "It draws 8 cells." }, { id: "f2", text: "It uses two glyphs." }], forbidden: [{ id: "x1", text: "It draws 10 cells." }] },
			followup: { prompt: "small followup", key: { facts: [{ id: "f1", text: "One cell is filled." }] } },
		},
		{
			id: "q-large", size: "large", prompt: "large question",
			key: { facts: [{ id: "f1", text: "The launcher picks a home." }] },
			followup: { prompt: "large followup", key: { facts: [{ id: "f1", text: "It requires pi 0.99." }], forbidden: [{ id: "x1", text: "No check." }] } },
		},
	],
};

async function fixture() {
	const root = await makeTempDir("grade-pi-");
	const runs = join(root, "runs");
	await buildShortBatch(runs);
	const setPath = join(root, "set.json");
	await writeFile(setPath, JSON.stringify(SET));
	return { root, runs, setPath, out: join(root, "grading"), log: join(root, "pi.log"), state: join(root, "pi.state"), keyIndex: buildKeyIndex(SET) };
}

const readLog = async (file) => (existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = async (file) => (await readLog(file)).filter((r) => r.argv);

/** Environment for the CLI: fake pi first on PATH, no NAN key unless given. */
function cliEnv(f, extra = {}) {
	const env = { ...process.env, PATH: `${dirname(FAKE_PI)}${delimiter}${process.env.PATH}`, FAKE_PI_JUDGE_LOG: f.log, ...extra };
	delete env.NAN_API_KEY;
	for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
	return env;
}

const messages = (system, user) => [{ role: "system", content: system }, { role: "user", content: user }];
const judgeEnv = (f, extra = {}) => ({ ...process.env, FAKE_PI_JUDGE_LOG: f.log, FAKE_PI_JUDGE_STATE: f.state, ...extra });
const noSleep = async () => {};

test("parseJudgeSpec selects the backend by prefix; the pi backend defaults to concurrency 1", () => {
	assert.deepEqual(parseJudgeSpec("nan/mimo-v2.6-flash"), { backend: "nan", spec: "nan/mimo-v2.6-flash", model: "nan/mimo-v2.6-flash" });
	assert.deepEqual(parseJudgeSpec(PI_JUDGE), { backend: "pi", spec: PI_JUDGE, model: "openai-codex/gpt-6.1-sol" });
	assert.equal(parseJudgeSpec("pi/openai-codex/gpt-6.1-sol:high").model, "openai-codex/gpt-6.1-sol:high");
	for (const bad of ["pi/gpt-6.1-sol", "pi/", "openai/gpt-5", "mimo-v2.6-flash", "nan/"]) assert.throws(() => parseJudgeSpec(bad), /--judge must be nan\/<model> or pi\/<provider>\/<model>/, bad);
	assert.equal(defaultConcurrency("pi"), 1);
	assert.equal(defaultConcurrency("nan"), 2);
});

test("piArgs isolates pi and passes the system prompt and user message as single arguments", () => {
	assert.deepEqual(piArgs({ model: "openai-codex/gpt-6.1-sol", system: "S", user: "U", jsonMode: true }), [
		"-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
		"--system-prompt", "S", "--model", "openai-codex/gpt-6.1-sol", "--mode", "json", "--", "U",
	]);
	assert.ok(!piArgs({ model: "m/x", system: "S", user: "U", jsonMode: false }).includes("--mode"));
});

test("createPiJudge spawns pi without a shell, stdin closed, the prompts intact, and parses the JSON-mode reply and usage", async () => {
	const f = await fixture();
	const system = "Rules line 1\n\"double\" 'single' $HOME `tick` ; rm -rf / &&\nlast line";
	const user = "<question>\nWhat? \"quoted\" $(echo no)\n</question>\n\nKey facts:\n- f1: It draws 8 cells.\n\nForbidden claims:\n- x1: It draws 10 cells.";
	const judge = createPiJudge({ model: "openai-codex/gpt-6.1-sol", command: FAKE_PI, env: judgeEnv(f, { NAN_API_KEY: "should-not-pass" }), sleep: noSleep });
	const result = await judge(messages(system, user));
	assert.deepEqual(JSON.parse(result.content), { facts: [{ id: "f1", supported: true }], forbidden: [{ id: "x1", present: false }], language: "en" });
	assert.deepEqual(result.usage, { promptTokens: 130, completionTokens: 30 }, "prompt = input + cacheRead + cacheWrite");
	assert.equal(result.attempts, 1);
	const [call] = await starts(f.log);
	assert.deepEqual(call.argv, piArgs({ model: "openai-codex/gpt-6.1-sol", system, user, jsonMode: true }));
	assert.equal(call.argv[call.argv.indexOf("--system-prompt") + 1], system);
	assert.equal(call.argv.at(-1), user);
	assert.equal(call.stdinBytes, 0, "stdin is closed (reads EOF at once)");
	assert.equal(call.nanKeySet, false, "NAN_API_KEY is not passed to pi");
});

test("createPiJudge in text mode returns stdout and reports usage as unavailable", async () => {
	const f = await fixture();
	const judge = createPiJudge({ model: "m/x", command: FAKE_PI, jsonMode: false, env: judgeEnv(f), sleep: noSleep });
	const result = await judge(messages("S", "- f1: a"));
	assert.equal(result.usage, null);
	assert.deepEqual(JSON.parse(result.content).facts, [{ id: "f1", supported: true }]);
	assert.ok(!(await starts(f.log))[0].argv.includes("--mode"));
});

test("gradeAnswers validates pi replies strictly and records unreported usage", async () => {
	const f = await fixture();
	const { answers } = await collectAnswers({ runsRoot: f.runs, selectors: ["fx-01-01-"], keyIndex: f.keyIndex });
	const json = createPiJudge({ model: "m/x", command: FAKE_PI, env: judgeEnv(f), sleep: noSleep });
	const records = await gradeAnswers(answers, { judge: json, judgeModel: "pi/m/x", cache: createCache(join(f.root, "c1")), concurrency: 1 });
	assert.ok(records.every((r) => r.score === 1 && r.error === null));
	assert.deepEqual(records[0].usage, { promptTokens: 130, completionTokens: 30, calls: 1, unreportedCalls: 0 });
	const text = createPiJudge({ model: "m/x", command: FAKE_PI, jsonMode: false, env: judgeEnv(f), sleep: noSleep });
	const textRecords = await gradeAnswers(answers, { judge: text, judgeModel: "pi/m/x-text", cache: createCache(join(f.root, "c2")), concurrency: 1 });
	assert.deepEqual(textRecords[0].usage, { promptTokens: 0, completionTokens: 0, calls: 1, unreportedCalls: 1 });
	const invalid = createPiJudge({ model: "m/x", command: FAKE_PI, env: judgeEnv(f, { FAKE_PI_JUDGE_MODE: "invalid" }), sleep: noSleep });
	const bad = await gradeAnswers(answers.slice(0, 1), { judge: invalid, judgeModel: "pi/m/x-invalid", cache: createCache(join(f.root, "c3")), concurrency: 1 });
	assert.match(bad[0].error, /invalid judge response/);
});

test("a pi call that exceeds the timeout is killed and retried", async () => {
	const f = await fixture();
	const judge = createPiJudge({ model: "m/x", command: FAKE_PI, timeoutMs: 400, maxRetries: 1, env: judgeEnv(f, { FAKE_PI_JUDGE_MODE: "hang-once" }), sleep: noSleep });
	const result = await judge(messages("S", "- f1: a"));
	assert.equal(result.attempts, 2);
	const [first] = await starts(f.log);
	assert.throws(() => process.kill(first.pid, 0), /ESRCH/, "the hung pi process was killed");

	const g = await fixture();
	const hung = createPiJudge({ model: "m/x", command: FAKE_PI, timeoutMs: 200, maxRetries: 0, env: judgeEnv(g, { FAKE_PI_JUDGE_MODE: "hang" }), sleep: noSleep });
	await assert.rejects(hung(messages("S", "U")), (error) => {
		assert.ok(error instanceof JudgeError);
		assert.equal(error.code, "timeout");
		assert.equal(error.exhausted, true);
		assert.match(error.message, /timeout/);
		return true;
	});
});

test("a rate-limited pi call is retried, then exhausted, and the batch breaker counts it", async () => {
	const f = await fixture();
	const sleeps = [];
	const judge = createPiJudge({ model: "m/x", command: FAKE_PI, maxRetries: 2, baseDelayMs: 10, env: judgeEnv(f, { FAKE_PI_JUDGE_MODE: "rate-limit" }), sleep: async (ms) => { sleeps.push(ms); } });
	await assert.rejects(judge(messages("S", "U")), (error) => {
		assert.equal(error.code, "rate_limited");
		assert.equal(error.retryable, true);
		assert.equal(error.exhausted, true);
		assert.equal(error.attempts, 3);
		assert.ok(!error.message.includes("PI-SECRET-STDERR"));
		assert.ok(!error.message.includes("Too Many Requests"), "no raw stderr text in the message");
		return true;
	});
	assert.equal((await starts(f.log)).length, 3);
	assert.deepEqual(sleeps, [10, 20]);

	const g = await fixture();
	const { answers } = await collectAnswers({ runsRoot: g.runs, selectors: ["fx-01-"], keyIndex: g.keyIndex });
	const limited = createPiJudge({ model: "m/x", command: FAKE_PI, maxRetries: 0, env: judgeEnv(g, { FAKE_PI_JUDGE_MODE: "rate-limit" }), sleep: noSleep });
	await assert.rejects(gradeAnswers(answers, { judge: limited, judgeModel: "pi/m/x", cache: createCache(join(g.root, "cache")), concurrency: 1, abortAfter: 2 }), (error) => {
		assert.ok(error instanceof JudgeAbortError);
		assert.ok(!error.message.includes("PI-SECRET-STDERR"));
		return true;
	});
	assert.equal((await starts(g.log)).length, 2, "the batch stops after two exhausted answers");
});

test("a usage-limit error reported inside the JSON stream is retryable", async () => {
	const f = await fixture();
	const judge = createPiJudge({ model: "m/x", command: FAKE_PI, maxRetries: 1, env: judgeEnv(f, { FAKE_PI_JUDGE_MODE: "usage-limit-json" }), sleep: noSleep });
	await assert.rejects(judge(messages("S", "U")), (error) => {
		assert.equal(error.code, "usage_limit");
		assert.equal(error.exhausted, true);
		assert.ok(!error.message.includes("PI-SECRET-STDERR"));
		return true;
	});
	assert.equal((await starts(f.log)).length, 2);
});

test("auth, bad model and a missing pi command are fatal and not retried", async () => {
	for (const [mode, code] of [["auth", "auth"], ["bad-model", "bad_model"]]) {
		const f = await fixture();
		const judge = createPiJudge({ model: "m/x", command: FAKE_PI, maxRetries: 3, env: judgeEnv(f, { FAKE_PI_JUDGE_MODE: mode }), sleep: noSleep });
		await assert.rejects(judge(messages("S", "U")), (error) => {
			assert.equal(error.code, code);
			assert.equal(error.retryable, false);
			assert.equal(error.exhausted, false);
			assert.ok(!error.message.includes("PI-SECRET-STDERR"));
			return true;
		});
		assert.equal((await starts(f.log)).length, 1, `${mode} is not retried`);
	}
	const missing = createPiJudge({ model: "m/x", command: "/nonexistent/pi-judge", maxRetries: 3, sleep: noSleep });
	await assert.rejects(missing(messages("S", "U")), (error) => error.code === "pi_not_found" && error.retryable === false);
});

test("classifyPiFailure maps pi failure text to a short code", () => {
	const cases = [
		["Error: 429 Too Many Requests", "rate_limited", true],
		["Rate limit reached for model gpt-6.1-sol", "rate_limited", true],
		["You have hit your usage limit. Try again in 3 hours.", "usage_limit", true],
		["insufficient_quota", "usage_limit", true],
		["request to https://chatgpt.com failed, reason: getaddrinfo ENOTFOUND chatgpt.com", "network", true],
		["socket hang up", "network", true],
		["Request timed out", "timeout", true],
		["503 Service Unavailable", "server", true],
		["overloaded_error", "server", true],
		["Model \"x/y\" not found", "bad_model", false],
		["Unknown model: openai-codex/nope", "bad_model", false],
		["No API key found for openai-codex", "auth", false],
		["401 Unauthorized", "auth", false],
		["Not logged in. Use /login", "auth", false],
		["something odd happened", "failed", false],
	];
	for (const [text, code, retryable] of cases) assert.deepEqual(classifyPiFailure(text), { code, retryable }, text);
});

test("sampleToAnswers rebuilds answers whose cache keys match the full grading run", async () => {
	const f = await fixture();
	const { answers } = await collectAnswers({ runsRoot: f.runs, selectors: ["fx-01-"], keyIndex: f.keyIndex });
	const sample = sampleBlind(answers, 3, 7);
	const rebuilt = sampleToAnswers(sample);
	assert.equal(rebuilt.length, 3);
	for (const a of rebuilt) {
		const original = answers.find((o) => o.answerKey === a.answerKey);
		const key = (x) => cacheKey({ turnId: x.turnId, answer: x.answer, key: x.key, judgeModel: PI_JUDGE, promptVersion: PROMPT_VERSION });
		assert.equal(key(a), key(original));
		assert.deepEqual(buildJudgeMessages({ prompt: a.key.prompt, answer: a.answer, facts: a.key.facts, forbidden: a.key.forbidden }), buildJudgeMessages({ prompt: original.key.prompt, answer: original.answer, facts: original.key.facts, forbidden: original.key.forbidden }));
	}
	assert.throws(() => sampleToAnswers({ schema: "other", entries: [] }), /not a calibration sample/);
});

test("grade.mjs --dry-run with the pi judge needs no NAN key and never spawns pi", async () => {
	const f = await fixture();
	const { stdout } = await run(process.execPath, [CLI, "--dry-run", "--judge", PI_JUDGE, "fx-01-", "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f) });
	assert.match(stdout, /judge pi\/openai-codex\/gpt-6\.1-sol \(pi backend\)/);
	assert.match(stdout, /to judge 6/);
	assert.match(stdout, /dry run: no judge call/);
	assert.equal(existsSync(f.log), false, "pi was never spawned");
});

test("grade.mjs grades with the pi judge without NAN_API_KEY, one call at a time by default", async () => {
	const f = await fixture();
	const { stdout } = await run(process.execPath, [CLI, "--judge", PI_JUDGE, "fx-01-", "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f, { FAKE_PI_JUDGE_DELAY_MS: "30" }) });
	assert.match(stdout, /8 answers: 6 judged, 0 cached, 1 deduplicated, 1 empty, 0 errors/);
	const log = await readLog(f.log);
	const calls = log.filter((r) => r.argv);
	assert.equal(calls.length, 6);
	assert.ok(calls.every((c) => c.argv.includes("openai-codex/gpt-6.1-sol") && c.nanKeySet === false));
	const intervals = calls.map((c) => [c.start, log.find((r) => r.end === c.pid).at]).sort((a, b) => a[0] - b[0]);
	for (let i = 1; i < intervals.length; i += 1) assert.ok(intervals[i][0] >= intervals[i - 1][1], "pi calls never overlap at the default concurrency");
	const lines = (await readFile(join(f.out, "grades.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines[0].judge.model, PI_JUDGE);
	const summary = JSON.parse(await readFile(join(f.out, "summary.json"), "utf8"));
	assert.equal(summary.usage.calls, 6);
	assert.equal(summary.usage.unreportedCalls, 0);
});

test("grade.mjs keeps raw pi stderr out of grades.jsonl and the summaries", async () => {
	const f = await fixture();
	await assert.rejects(run(process.execPath, [CLI, "--judge", PI_JUDGE, "fx-01-", "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f, { FAKE_PI_JUDGE_MODE: "auth" }) }), (error) => {
		assert.equal(error.code, 2);
		assert.ok(!error.stdout.includes("PI-SECRET-STDERR") && !error.stderr.includes("PI-SECRET-STDERR"));
		return true;
	});
	for (const file of ["grades.jsonl", "summary.json", "summary.md"]) assert.ok(!(await readFile(join(f.out, file), "utf8")).includes("PI-SECRET-STDERR"), file);
	assert.match(await readFile(join(f.out, "grades.jsonl"), "utf8"), /pi judge failed: auth/);
});

test("grade.mjs still requires NAN_API_KEY for the nan judge and rejects an unknown judge prefix", async () => {
	const f = await fixture();
	await assert.rejects(run(process.execPath, [CLI, "--judge", "nan/mimo-v2.6-flash", "fx-01-", "--runs", f.runs, "--set", f.setPath, "--out", f.out, "--judge-url", "http://127.0.0.1:9/v1"], { env: cliEnv(f) }), /NAN_API_KEY is not set/);
	await assert.rejects(run(process.execPath, [CLI, "--dry-run", "--judge", "openai/gpt-5", "fx-01-", "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f) }), /--judge must be nan\/<model> or pi\/<provider>\/<model>/);
	assert.equal(existsSync(f.log), false);
});

test("grade.mjs --judge-sample judges a blind sample into an agreement-compatible file, cached per judge", async () => {
	const f = await fixture();
	const sampleFile = join(f.out, "calibration-sample.json");
	await run(process.execPath, [CLI, "fx-01-", "--sample", "4", "--seed", "7", "--export", sampleFile, "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f) });

	const dry = await run(process.execPath, [CLI, "--judge-sample", sampleFile, "--judge", PI_JUDGE, "--dry-run", "--out", f.out], { env: cliEnv(f) });
	assert.match(dry.stdout, /sample +1 runs +4 turns +4 answers +0 empty +0 cached +0 duplicate +to judge 4/);
	assert.match(dry.stdout, /dry run: no judge call/);
	assert.equal(existsSync(f.log), false, "the dry run never spawns pi");

	const resultsA = join(f.out, "judge-a.json");
	const first = await run(process.execPath, [CLI, "--judge-sample", sampleFile, "--judge", PI_JUDGE, "--export", resultsA, "--out", f.out], { env: cliEnv(f) });
	assert.match(first.stdout, /4 sample answers: 4 judged, 0 cached, 0 errors/);
	assert.match(first.stdout, /wrote .*judge-a\.json/);
	assert.equal((await starts(f.log)).length, 4);
	const sample = JSON.parse(await readFile(sampleFile, "utf8"));
	const results = JSON.parse(await readFile(resultsA, "utf8"));
	assert.equal(results.judgeModel, PI_JUDGE);
	assert.equal(results.promptVersion, PROMPT_VERSION);
	assert.deepEqual(results.entries.map((e) => e.sampleId), sample.entries.map((e) => e.sampleId));
	for (const entry of results.entries) {
		assert.ok(entry.facts.every((x) => typeof x.supported === "boolean" && typeof x.text === "string"));
		assert.ok(entry.forbidden.every((x) => typeof x.present === "boolean"));
		assert.equal(entry.language, "en");
		assert.equal(entry.error, null);
	}

	const again = await run(process.execPath, [CLI, "--judge-sample", sampleFile, "--judge", PI_JUDGE, "--export", join(f.out, "judge-a2.json"), "--out", f.out], { env: cliEnv(f) });
	assert.match(again.stdout, /4 sample answers: 0 judged, 4 cached, 0 errors/);
	assert.equal((await starts(f.log)).length, 4, "a rerun with the same judge is served from the cache");

	const resultsB = join(f.out, "judge-b.json");
	await run(process.execPath, [CLI, "--judge-sample", sampleFile, "--judge", "pi/other/model", "--export", resultsB, "--out", f.out], { env: cliEnv(f, { FAKE_PI_JUDGE_SUPPORTED: "f1" }) });
	assert.equal((await starts(f.log)).length, 8, "another judge model does not share cache entries");

	const self = JSON.parse((await run(process.execPath, [CLI, "--agreement", resultsA, resultsA])).stdout);
	assert.equal(self.answers, 4);
	assert.equal(self.facts.rate, 1);
	assert.equal(self.missingFromJudge, 0);
	const cross = JSON.parse((await run(process.execPath, [CLI, "--agreement", resultsB, resultsA])).stdout);
	assert.equal(cross.answers, 4);
	const hasF2 = sample.entries.some((e) => e.facts.some((x) => x.id === "f2"));
	if (hasF2) assert.ok(cross.facts.rate < 1, "different judges disagree on f2");
});

test("grade.mjs --judge-sample writes a default results file named after the judge", async () => {
	const f = await fixture();
	const sampleFile = join(f.out, "calibration-sample.json");
	await run(process.execPath, [CLI, "fx-01-", "--sample", "2", "--seed", "7", "--export", sampleFile, "--runs", f.runs, "--set", f.setPath, "--out", f.out], { env: cliEnv(f) });
	await run(process.execPath, [CLI, "--judge-sample", sampleFile, "--judge", PI_JUDGE, "--out", f.out], { env: cliEnv(f) });
	const results = JSON.parse(await readFile(join(f.out, "sample-judgments", "pi_openai-codex_gpt-6.1-sol.json"), "utf8"));
	assert.equal(results.entries.length, 2);
});
