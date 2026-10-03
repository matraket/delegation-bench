import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildShortBatch, makeTempDir } from "./bench-fixture.mjs";
import { exportResults } from "../lib/export/index.mjs";
import { findHomePaths, relativizePaths } from "../lib/export/paths.mjs";
import { parseUsageLog } from "../lib/export/usage.mjs";

// Built at runtime so the repository text holds no home-directory path.
const HOMES = `/${"home"}`;
const TESTER = `${HOMES}/tester`;

test("absolute paths under the repository and the bench directory become relative; other values stay", () => {
	const value = {
		questionFile: "/work/repo/questions/generated/long.json",
		runsRoot: "/work/repo/.bench/runs",
		root: "/work/repo",
		note: "read /work/repo/.bench/runs/x/manifest.json first",
		count: 3,
		nested: [{ path: "/tmp/elsewhere/file" }, null, true],
	};
	const result = relativizePaths(value, { repoRoot: "/work/repo", benchDir: "/work/repo/.bench" });
	assert.deepEqual(result, {
		questionFile: "questions/generated/long.json",
		runsRoot: ".bench/runs",
		root: ".",
		note: "read .bench/runs/x/manifest.json first",
		count: 3,
		nested: [{ path: "/tmp/elsewhere/file" }, null, true],
	});
});

test("home paths are found in any text: the given home and user directories under /home and /Users", () => {
	assert.deepEqual(findHomePaths("see /srv/me/x and /srv/me", { home: "/srv/me" }), ["/srv/me/x", "/srv/me"]);
	assert.deepEqual(findHomePaths(`{"a":"${HOMES}/alice/.pi/agent"}`, { home: "/srv/me" }), [`${HOMES}/alice/.pi/agent`]);
	assert.deepEqual(findHomePaths("path /Users/bob/project", { home: "/srv/me" }), ["/Users/bob/project"]);
	assert.deepEqual(findHomePaths("~/.gentle-shell/agent, /tmp/gentle-shell-resume-1/handoff.json, /nonexistent/agent-home/x", { home: "/srv/me" }), []);
});

test("usage lines are read in both recorded formats, per model when the line names one", () => {
	const log = [
		"2026-10-01T10:00:00Z usage-before [{\"date\":\"2026-10-01\",\"prompt_tokens\":100,\"completion_tokens\":10,\"api_requests\":2}]",
		"2026-10-01T10:00:01Z start 1/2 inline r1",
		"2026-10-01T11:00:00Z end 1/2 inline r1 rc=0 ... -> /some/abs/path",
		"2026-10-01T12:00:00Z usage-after [{\"date\":\"2026-10-01\",\"prompt_tokens\":1100,\"completion_tokens\":60,\"api_requests\":12}]",
		"2026-10-01T13:00:00Z m2 usage-before []",
		"2026-10-01T14:00:00Z m2 usage-after [{\"date\":\"2026-10-01\",\"prompt_tokens\":500,\"completion_tokens\":5,\"api_requests\":3}]",
		"2026-10-01T22:00:00Z usage-before {\"days\":[\"2026-10-01\"],\"prompt_tokens\":1000,\"completion_tokens\":100,\"api_requests\":10}",
		"2026-10-02T02:00:00Z usage-after {\"days\":[\"2026-10-01\",\"2026-10-02\"],\"prompt_tokens\":4000,\"completion_tokens\":400,\"api_requests\":40}",
	].join("\n");
	const segments = parseUsageLog(log);
	assert.deepEqual(segments.map((s) => [s.model, s.delta]), [
		[null, { promptTokens: 1000, completionTokens: 50, requests: 10 }],
		["m2", { promptTokens: 500, completionTokens: 5, requests: 3 }],
		[null, { promptTokens: 3000, completionTokens: 300, requests: 30 }],
	]);
	assert.deepEqual(segments[2].days, ["2026-10-01", "2026-10-02"]);
	assert.equal(segments[0].before.at, "2026-10-01T10:00:00Z");
	assert.throws(() => parseUsageLog("2026-10-01T10:00:00Z usage-after []"), /usage-after without a usage-before/);
});

async function makeBench({ answer = "The answer names lib/a.ts." } = {}) {
	const repoRoot = await makeTempDir("export-repo-");
	const benchDir = join(repoRoot, ".bench");
	const runs = join(benchDir, "runs");
	await mkdir(runs, { recursive: true });
	await buildShortBatch(runs);
	await mkdir(join(benchDir, "fx-logs"), { recursive: true });
	await writeFile(join(benchDir, "fx-logs", "progress.log"), [
		"2026-01-01T00:00:00Z usage-before []",
		`2026-01-01T00:00:01Z end 1/4 rc=0 -> ${runs}/fx-01-01`,
		"2026-01-01T01:00:00Z usage-after [{\"date\":\"2026-01-01\",\"prompt_tokens\":1960000,\"completion_tokens\":20000,\"api_requests\":40}]",
		"",
	].join("\n"));
	const grading = join(benchDir, "grading");
	await mkdir(join(grading, "sample-judgments"), { recursive: true });
	const record = (arm, turnId, score) => ({ answerKey: `${arm}-${turnId}`, turnId, questionId: "q-small", size: "small", followup: turnId.endsWith("-followup"), judge: { model: "pi/x/y", promptVersion: "grade-v1", source: "judge" }, skipped: null, error: null, facts: [{ id: "f1", supported: score === 1 }], forbidden: [], language: "en", score, supported: score, totalFacts: 1, forbiddenPresent: [], fullyCorrect: score === 1, usage: { promptTokens: 100, completionTokens: 10, calls: 1, unreportedCalls: 0 }, batch: "fx-01", runId: `fx-01-0${arm === "inline" ? 1 : 2}-q-small-${arm}`, arm, model: "nan/test-model", replicate: 1, kind: "short", turnIndex: 0, turnStatus: "settled", answerChars: 30 });
	const records = [record("inline", "q-small", 1), record("delegate", "q-small", 0), record("inline", "q-small-followup", 1), record("delegate", "q-small-followup", 1)];
	await writeFile(join(grading, "grades.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
	await writeFile(join(grading, "summary.json"), `${JSON.stringify({ judgeModel: "pi/x/y", answers: 4, groups: [] }, null, 2)}\n`);
	await writeFile(join(grading, "summary.md"), "# Grades\n");
	const entry = (verdict) => ({ sampleId: "s1", turnId: "q-small", question: "Q? Answer in English.", answer, facts: [{ id: "f1", text: "fact", supported: verdict }], forbidden: [], language: verdict === null ? null : "en" });
	await writeFile(join(grading, "calibration-sample.json"), JSON.stringify({ schema: "delegation-bench.calibration-sample/v1", seed: 1, size: 1, entries: [entry(null)] }));
	await writeFile(join(grading, "reference.json"), JSON.stringify({ schema: "delegation-bench.calibration-sample/v1", seed: 1, size: 1, entries: [entry(true)] }));
	await writeFile(join(grading, "sample-judgments", "judge.json"), JSON.stringify({ schema: "delegation-bench.sample-judgments/v1", judgeModel: "pi/x/y", entries: [{ ...entry(true), source: "judge", error: null }] }));
	const config = {
		batches: [{ name: "fx-01", selector: "fx-01-", log: "fx-logs/progress.log", logModel: null }],
		calibration: { sample: "grading/calibration-sample.json", reference: "grading/reference.json", judge: "grading/sample-judgments/judge.json" },
	};
	return { repoRoot, benchDir, config };
}

async function listFiles(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)));
	return out.sort();
}

test("export writes the documented layout without absolute paths, and a second run writes the same bytes", async () => {
	const { repoRoot, benchDir, config } = await makeBench();
	const outDir = join(repoRoot, "results");
	const first = await exportResults({ benchDir, outDir, repoRoot, home: TESTER, ...config });
	const files = await listFiles(outDir);
	assert.deepEqual(files, [
		"README.md",
		"batches/fx-01.json",
		"batches/fx-01.md",
		"calibration/agreement.json",
		"calibration/agreement.md",
		"calibration/judge.json",
		"calibration/reference.json",
		"calibration/sample.json",
		"grading/grades.jsonl",
		"grading/summary.json",
		"grading/summary.md",
		"provenance.json",
		"provenance.md",
		"quality.json",
		"quality.md",
		"usage-control.json",
		"usage-control.md",
	]);
	assert.deepEqual(first.files, files);
	const snapshot = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(outDir, f), "utf8")])));
	for (const [file, text] of Object.entries(snapshot)) assert.ok(!text.includes(repoRoot), `${file} keeps an absolute path`);
	const report = JSON.parse(snapshot["batches/fx-01.json"]);
	assert.equal(report.runsRoot, ".bench/runs");
	assert.ok(report.sessions.every((s) => s.questionFile.startsWith(".bench/runs/questions/")));
	const usage = JSON.parse(snapshot["usage-control.json"]);
	assert.deepEqual(usage.batches[0].provider, { promptTokens: 1960000, completionTokens: 20000, requests: 40, days: ["2026-01-01"] });
	assert.equal(usage.batches[0].analyzer.promptTokens, 1940000);
	assert.equal(usage.batches[0].difference.promptTokens, -20000);
	const provenance = JSON.parse(snapshot["provenance.json"]);
	assert.equal(provenance.batches[0].sessions, 4);
	assert.deepEqual(provenance.batches[0].groups.map((g) => [g.model, g.arms, g.sessions]), [["nan/test-model", ["delegate", "inline"], 4]]);
	const agreement = JSON.parse(snapshot["calibration/agreement.json"]);
	assert.equal(agreement.facts.agree, 1);
	const quality = JSON.parse(snapshot["quality.json"]);
	assert.equal(quality.comparisons[0].n, 2);
	await exportResults({ benchDir, outDir, repoRoot, home: TESTER, ...config });
	for (const file of files) assert.equal(await readFile(join(outDir, file), "utf8"), snapshot[file], file);
});

test("export fails when a written file still holds a path under the home directory", async () => {
	const { repoRoot, benchDir, config } = await makeBench({ answer: `Read ${TESTER}/.config/secret.txt first.` });
	await assert.rejects(exportResults({ benchDir, outDir: join(repoRoot, "results"), repoRoot, home: TESTER, ...config }), (error) => {
		assert.match(error.message, /calibration\/sample\.json: \/home\/tester\/\.config\/secret\.txt/);
		return true;
	});
});

test("export refuses grades that carry answer text", async () => {
	const { repoRoot, benchDir, config } = await makeBench();
	const path = join(benchDir, "grading", "grades.jsonl");
	const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	lines[0].answer = "leaked answer text";
	await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	await assert.rejects(exportResults({ benchDir, outDir: join(repoRoot, "results"), repoRoot, home: TESTER, ...config }), /grades\.jsonl line 1 carries answer text \(answer\)/);
});
