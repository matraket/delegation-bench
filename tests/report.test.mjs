import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assistant, buildLongBatch, buildShortBatch, makeTempDir, toolResult, user } from "./bench-fixture.mjs";
import { detectLanguage } from "../lib/report/language.mjs";
import { median, minMax } from "../lib/report/stats.mjs";
import { userTurns } from "../lib/report/turns.mjs";
import { discoverRuns, matchSelector } from "../lib/report/runs.mjs";
import { buildReport } from "../lib/report/index.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "report.mjs");

async function fixtureRoot() {
	const root = await makeTempDir("report-");
	const runs = join(root, "runs");
	await buildShortBatch(runs);
	await buildLongBatch(runs);
	return runs;
}

const armOf = (report, arm) => report.groups[0].arms.find((a) => a.arm === arm);

test("median, minMax match the prototype definitions", () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([]), null);
	assert.deepEqual(minMax([5, 2, 9]), { min: 2, max: 9 });
	assert.deepEqual(minMax([]), { min: null, max: null });
});

test("userTurns splits at user messages and measures evidence, rounds and the last non-empty text", () => {
	const turns = userTurns([
		{ type: "session" },
		user("q1"), assistant(null, { tools: 2 }), toolResult(8000), toolResult(4001), assistant("first"), assistant("final one"),
		user("q2"), assistant("only"), assistant("  "), assistant(null, { tools: 1 }),
	]);
	assert.equal(turns.length, 2);
	assert.deepEqual(turns.map((t) => [t.prompt, t.rounds, t.chars, t.evidenceTokens, t.text]), [
		["q1", 1, 12001, 3000, "final one"],
		["q2", 1, 0, 0, "only"],
	]);
});

test("detectLanguage reproduces the prototype word-count heuristic", () => {
	assert.equal(detectLanguage("El archivo que está en la función para los usuarios"), "es");
	assert.equal(detectLanguage("The file that holds the function and this answer"), "en");
	assert.equal(detectLanguage(""), null);
});

test("matchSelector supports a run-id prefix and a glob", () => {
	assert.equal(matchSelector("pilot-01-")("pilot-01-03-s1-inline"), true);
	assert.equal(matchSelector("pilot-01-")("pilot-02-x"), false);
	assert.equal(matchSelector("long-0?-*-delegate-*")("long-02-05-delegate-r1"), true);
	assert.equal(matchSelector("long-0?-*-delegate-*")("long-02-05-inline-r1"), false);
});

test("discoverRuns reads arm, model, question and repetition from the manifest", async () => {
	const runs = await fixtureRoot();
	const short = await discoverRuns(runs, "fx-01-");
	assert.equal(short.length, 4);
	const first = short.find((r) => r.meta.runId === "fx-01-01-q-small-inline").meta;
	assert.deepEqual({ ...first, questionFile: undefined }, {
		runId: "fx-01-01-q-small-inline", arm: "inline", model: "nan/test-model", modelDir: "nan_test-model",
		rep: 1, replicate: 1, kind: "short", question: "q-small", size: "small", questionFile: undefined, questionSetId: "set/short/q-small",
	});
	const long = await discoverRuns(runs, "lg-01-");
	assert.deepEqual(long.map((r) => [r.meta.kind, r.meta.replicate]).sort(), [["long", 1], ["long", 1], ["long", 2], ["long", 2]]);
});

// Parity: the expected numbers below are the output of the prototypes
// `.bench/analysis/pilot-report.mjs` and `long-report.mjs` run on exactly this
// fixture (RUNS pointed at the fixture root, model dir nan_test-model).
test("short batch aggregates match the pilot-report prototype on the fixture", async () => {
	const report = await buildReport({ runsRoot: await fixtureRoot(), selector: "fx-01-" });
	assert.equal(report.sessionCount, 4);
	assert.deepEqual(report.totals, { prompt: 1940000, output: 20000, zeroUsageTurns: 1, statuses: ["completed"] });
	const inline = armOf(report, "inline");
	const delegate = armOf(report, "delegate");
	assert.deepEqual(
		[inline.delegatedSessions, inline.children, inline.nan.total, inline.nan.median, inline.ratioVsInline, inline.final.median, Math.round(inline.wallSeconds.median), `${inline.overBudgetTurns}/${inline.userTurns}`, inline.maxEvidence],
		[0, 0, 1100000, 550000, 1, 46000, 89, "2/4", 11000],
	);
	assert.deepEqual(
		[delegate.delegatedSessions, delegate.children, delegate.nan.total, delegate.nan.median, delegate.ratioVsInline.toFixed(2), delegate.final.median, Math.round(delegate.wallSeconds.median), `${delegate.overBudgetTurns}/${delegate.userTurns}`, delegate.maxEvidence],
		[2, 5, 860000, 430000, "0.98", 28500, 140, "0/4", 750],
	);
	assert.equal(armOf(report, "shipped").sessions, 0);
	const bySize = report.groups[0].sizes;
	assert.deepEqual(bySize.map((s) => [s.size, s.arm, s.sessions, s.nan.median]), [
		["small", "inline", 1, 200000], ["small", "delegate", 1, 260000],
		["large", "inline", 1, 900000], ["large", "delegate", 1, 600000],
	]);
	assert.equal(bySize.find((s) => s.size === "small" && s.arm === "delegate").ratioVsInline, 1.3);
});

test("long batch aggregates match the long-report prototype on the fixture", async () => {
	const report = await buildReport({ runsRoot: await fixtureRoot(), selector: "lg-01-" });
	assert.equal(report.groups[0].kind, "long");
	assert.deepEqual(report.totals, { prompt: 29300000, output: 200000, zeroUsageTurns: 0, statuses: ["completed"] });
	assert.equal(report.turnsSettled, 56);
	const inline = armOf(report, "inline");
	const delegate = armOf(report, "delegate");
	const row = (a) => [a.sessions, a.delegatedSessions, a.children, a.nan.median, a.nan.min, a.nan.max, Math.round(a.api.median), a.peak.median, a.final.median, Math.round(a.wallSeconds.median / 60), `${a.overBudgetTurns}/${a.userTurns}`, `${a.language.es}(${a.language.esLate})`];
	assert.deepEqual(row(inline), [2, 0, 0, 9500000, 9000000, 10000000, 1550000, 155000, 154000, 17, "1/28", "0(0)"]);
	assert.deepEqual(row(delegate), [2, 2, 50, 5250000, 4000000, 6500000, 1950000, 85000, 83500, 31, "0/28", "3(2)"]);
	assert.equal(inline.ratioVsInline, null, "no per-question ratio for long batches");
});

test("per-session rows carry evidence and language per user turn", async () => {
	const report = await buildReport({ runsRoot: await fixtureRoot(), selector: "fx-01-" });
	const s = report.sessions.find((r) => r.runId === "fx-01-03-q-large-inline");
	assert.deepEqual(s.turns.map((t) => [t.id, t.evidenceTokens, t.rounds, t.overBudget, t.language]), [
		["q-large", 1500, 6, true, "en"],
		["q-large-followup", 11000, 1, true, "en"],
	]);
	assert.equal(s.zeroUsageTurns, 1);
	assert.equal(s.delegated, false);
});

test("report.mjs writes JSON and Markdown per batch and prints a summary", async () => {
	const runs = await fixtureRoot();
	const out = join(await makeTempDir("report-out-"), "reports");
	const { stdout } = await run(process.execPath, [CLI, "fx-01-", "lg-01-", "--runs", runs, "--out", out]);
	assert.match(stdout, /fx-01-: 4 sessions/);
	assert.match(stdout, /\| inline \|/);
	const json = JSON.parse(await readFile(join(out, "fx-01.json"), "utf8"));
	assert.equal(json.selector, "fx-01-");
	const md = await readFile(join(out, "lg-01.md"), "utf8");
	assert.match(md, /\| delegate \| 2\/2 \| 50 \| 5.25M \(4.00-6.50M\) \|/);
});

test("report.mjs fails clearly when a selector matches no run", async () => {
	const runs = await fixtureRoot();
	await assert.rejects(run(process.execPath, [CLI, "nothing-", "--runs", runs, "--out", join(runs, "out")]), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /no runs match "nothing-"/);
		return true;
	});
});

// Real-data parity, skipped when the gitignored prototypes or runs are absent.
const PROTOTYPES = join(ROOT, ".bench", "analysis");
const REAL_RUNS = join(ROOT, ".bench", "runs");
const haveReal = existsSync(join(PROTOTYPES, "pilot-report.mjs")) && existsSync(join(REAL_RUNS, "pilot-01-01-l2-prompt-history-inline"));

test("real pilot-01 and long-01 numbers equal the prototype output", { skip: !haveReal && "prototypes or .bench/runs not present" }, async () => {
	const cases = [
		["pilot-report.mjs", "pilot-01-", (a) => [a.delegatedSessions, a.children, a.nan.total, a.nan.median, (a.ratioVsInline ?? 0).toFixed(2), a.final.median, Math.round(a.wallSeconds.median), `${a.overBudgetTurns}/${a.userTurns}`, a.maxEvidence]],
		["long-report.mjs", "long-01-", (a) => [a.sessions, a.delegatedSessions, a.children, a.nan.median, a.nan.min, a.nan.max, Math.round(a.api.median), a.peak.median, a.final.median, Math.round(a.wallSeconds.median / 60), `${a.overBudgetTurns}/${a.userTurns}`, `${a.language.es}(${a.language.esLate})`]],
	];
	for (const [script, prefix, row] of cases) {
		const { stdout } = await run(process.execPath, [join(PROTOTYPES, script), prefix, "nan_glm5.3-flash"]);
		const expected = Object.fromEntries(stdout.trim().split("\n").slice(2).map((line) => {
			const [arm, ...cells] = line.trim().split(/\s+/);
			return [arm, cells];
		}));
		const report = await buildReport({ runsRoot: REAL_RUNS, selector: prefix });
		for (const a of report.groups[0].arms) assert.deepEqual(row(a).map(String), expected[a.arm], `${prefix} ${a.arm}`);
	}
});
