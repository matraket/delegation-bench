import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bootstrapCI, compareArms, gradedRows, indexByArm, prototypeRandom, qualityComparisons, renderQualityMarkdown } from "../lib/report/quality.mjs";

const run = promisify(execFile);

const grade = (arm, turnId, score, extra = {}) => ({ batch: "b-01", model: "nan/m", turnId, replicate: 1, arm, score, size: "small", followup: turnId.endsWith("-followup"), kind: "short", error: null, skipped: null, ...extra });

test("pairs answers by batch, model, turn and replicate, and counts signs", () => {
	const rows = [
		grade("delegate", "q1", 0.5), grade("inline", "q1", 1),
		grade("delegate", "q2", 1), grade("inline", "q2", 0.75),
		grade("delegate", "q3", 1), grade("inline", "q3", 1),
		grade("delegate", "q4", 0.2), // no inline partner
		grade("inline", "q1", 0, { replicate: 2 }), // no delegate partner
		grade("delegate", "q1", 0, { model: "nan/other" }), // other model, no partner
	];
	const result = compareArms(indexByArm(gradedRows(rows)), "delegate", "inline", { rand: prototypeRandom(1), iterations: 200 });
	assert.equal(result.n, 3);
	assert.equal(result.worse, 1);
	assert.equal(result.better, 1);
	assert.equal(result.ties, 1);
	assert.ok(Math.abs(result.meanDiff - (-0.5 + 0.25 + 0) / 3) < 1e-12);
	assert.ok(result.ci95[0] <= result.meanDiff && result.meanDiff <= result.ci95[1]);
	assert.ok(result.ci95[0] >= -0.5 && result.ci95[1] <= 0.25);
});

test("answers with an error, a skip or no score are left out", () => {
	const rows = gradedRows([grade("inline", "q1", 1), grade("inline", "q2", null), grade("inline", "q3", 1, { error: "x" }), grade("inline", "q4", 0, { skipped: "empty" })]);
	assert.deepEqual(rows.map((r) => r.turnId), ["q1"]);
});

test("the bootstrap is deterministic for a seed, and a constant difference has a zero-width interval", () => {
	const diffs = [-0.5, 0, 0.25, -0.1, 0.3];
	assert.deepEqual(bootstrapCI(diffs, prototypeRandom(5139), 500), bootstrapCI(diffs, prototypeRandom(5139), 500));
	assert.notDeepEqual(bootstrapCI(diffs, prototypeRandom(5139), 500), bootstrapCI(diffs, prototypeRandom(7), 500));
	assert.deepEqual(bootstrapCI([0.25, 0.25, 0.25], prototypeRandom(5139), 100), [0.25, 0.25]);
});

test("a comparison without pairs reports nulls and consumes no random numbers", () => {
	const byArm = indexByArm(gradedRows([grade("inline", "q1", 1)]));
	const rand = prototypeRandom(5139);
	const empty = compareArms(byArm, "delegate", "inline", { rand, iterations: 100 });
	assert.deepEqual({ n: empty.n, meanDiff: empty.meanDiff, ci95: empty.ci95 }, { n: 0, meanDiff: null, ci95: null });
	assert.equal(rand(), prototypeRandom(5139)());
});

test("the comparison set follows the study order and subsets, with judge usage totals", () => {
	const rows = [];
	for (const model of ["nan/a", "nan/b"]) {
		for (const arm of ["old-rules", "inline", "shipped", "delegate"]) {
			rows.push(grade(arm, "q1", arm === "delegate" ? 0.5 : 1, { model, usage: { promptTokens: 10, completionTokens: 1 } }));
			rows.push(grade(arm, "q1-followup", 1, { model, size: "large", batch: "long-01", kind: "long" }));
		}
	}
	const result = qualityComparisons(rows, { iterations: 50 });
	assert.equal(result.graded, 16);
	assert.deepEqual(result.judgeUsage, { promptTokens: 80, completionTokens: 8 });
	assert.deepEqual(result.comparisons.map((c) => `${c.a}-${c.b}:${c.subset}`), [
		"delegate-inline:all", "delegate-shipped:all", "delegate-old-rules:all", "shipped-inline:all", "old-rules-inline:all",
		"delegate-inline:size=small", "delegate-inline:size=medium", "delegate-inline:size=large",
		"delegate-inline:follow-ups", "delegate-inline:first questions",
		"delegate-inline:model=nan/a", "delegate-inline:model=nan/b",
		"delegate-inline:long sessions", "delegate-inline:short sessions",
	]);
	const markdown = renderQualityMarkdown(result);
	assert.match(markdown, /\| delegate - inline \| all \| 4 \| -0\.250 \|/);
	assert.match(markdown, /\| delegate - inline \| size=medium \| 0 \| - \| - \|/);
});

const PROTOTYPE = fileURLToPath(new URL("../.bench/analysis/quality-diff.mjs", import.meta.url));
const GRADES = fileURLToPath(new URL("../.bench/grading/grades.jsonl", import.meta.url));

test("matches the prototype script on the real grades", { skip: !(existsSync(PROTOTYPE) && existsSync(GRADES)) && "no .bench grading data" }, async () => {
	const { stdout } = await run(process.execPath, [PROTOTYPE]);
	const expected = stdout.trim().split("\n").filter((line) => line.includes(" n=")).map((line) => {
		const m = /^(\S+) - (\S+)(?: \[(.+)\])?: n=(\d+) meanDiff=(\S+) CI95=\[(\S+), (\S+)\] \S+ worse=(\d+) better=(\d+) ties=(\d+)$/.exec(line);
		return m.slice(4).map(Number);
	});
	const records = readFileSync(GRADES, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const actual = qualityComparisons(records).comparisons.map((c) => [c.n, Number(c.meanDiff.toFixed(3)), Number(c.ci95[0].toFixed(3)), Number(c.ci95[1].toFixed(3)), c.worse, c.better, c.ties]);
	// The prototype also compares by model in first-seen order; the module uses the same order.
	assert.equal(actual.length, expected.length);
	assert.deepEqual(actual, expected);
});
