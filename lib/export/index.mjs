// Privacy-safe export of aggregated study results from the gitignored bench
// directory into a committed results directory. Only aggregates, verdicts and
// the blind calibration sample are written: never session JSONL, events.jsonl,
// stderr.log, agent homes or arm package copies. Absolute paths are made
// relative, and every written file is scanned for paths under a home
// directory; the export fails if one survives. Output is deterministic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { computeAgreement } from "../grade/sample.mjs";
import { buildReport } from "../report/index.mjs";
import { renderMarkdown } from "../report/markdown.mjs";
import { discoverRuns } from "../report/runs.mjs";
import { qualityComparisons, renderQualityMarkdown } from "../report/quality.mjs";
import { findHomePaths, relativizePaths } from "./paths.mjs";
import { parseUsageLog } from "./usage.mjs";

export const EXPORT_SCHEMA_VERSION = 1;

// Keys that would carry answer or prompt text; grade records must have none.
const TEXT_KEYS = ["answer", "text", "prompt", "question"];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function findTextKey(node) {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findTextKey(item);
			if (found) return found;
		}
		return null;
	}
	if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (TEXT_KEYS.includes(key)) return key;
			const found = findTextKey(value);
			if (found) return found;
		}
	}
	return null;
}

const commitOf = (path) => {
	const name = path ? String(path).split(/[\\/]/).pop() : "";
	return /^[0-9a-f]{40}(?=\.|$)/.exec(name)?.[0] ?? null;
};

/** Which Gentle Shell package (and donor) each batch actually ran, from the run manifests. */
async function provenanceEntry(benchDir, batch) {
	const runs = await discoverRuns(join(benchDir, "runs"), batch.selector);
	const groups = new Map();
	for (const { manifest } of runs) {
		const info = manifest.armInfo ?? {};
		const row = {
			packageCommit: commitOf(info.source),
			packageVersion: info.sourceVersion ?? null,
			donorCommit: commitOf(info.donor),
			model: manifest.model ?? null,
			thinking: manifest.thinking ?? null,
			contextFixture: manifest.contextFixture ?? null,
			background: manifest.background ?? null,
		};
		const key = JSON.stringify(row);
		if (!groups.has(key)) groups.set(key, { ...row, sessions: 0, arms: new Set() });
		const group = groups.get(key);
		group.sessions += 1;
		group.arms.add(manifest.arm);
	}
	const rows = [...groups.values()].map((g) => ({ ...g, arms: [...g.arms].sort() }));
	rows.sort((x, y) => JSON.stringify([x.packageCommit, x.donorCommit, x.model]).localeCompare(JSON.stringify([y.packageCommit, y.donorCommit, y.model])));
	return { batch: batch.name, sessions: runs.length, groups: rows };
}

function provenanceMarkdown(provenance) {
	const short = (commit) => (commit ? `\`${commit.slice(0, 8)}\`` : "-");
	const rows = provenance.batches.flatMap((b) => b.groups.map((g) => `| ${b.batch} | ${short(g.packageCommit)} | ${g.packageVersion ?? "-"} | ${short(g.donorCommit)} | ${g.model ?? "-"} | ${g.arms.join(", ")} | ${g.sessions} | ${g.thinking ?? "-"} | ${g.contextFixture ?? "-"} | ${g.background === null ? "-" : g.background ? "on" : "off"} |`));
	return [
		"# Provenance: packages and settings per batch",
		"",
		"| Batch | Package commit | Package version | Donor commit | Model | Arms | Sessions | Thinking | Context fixture | Background subagents |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"From each run's manifest: the Gentle Shell package directory every arm was copied from (commit from its directory name, version from its package.json), the donor package of the old-rules arm, and the run settings.",
		"",
	].join("\n");
}

function usageEntry(batch, report, segments) {
	const segment = segments.find((s) => s.model === (batch.logModel ?? null));
	const analyzer = { sessions: report.sessionCount, promptTokens: report.totals.prompt, outputTokens: report.totals.output, zeroUsageTurns: report.totals.zeroUsageTurns };
	if (!segment) return { batch: batch.name, models: report.groups.map((g) => g.model), provider: null, analyzer, difference: null };
	const pct = (a, p) => (p === 0 ? null : (a - p) / p);
	return {
		batch: batch.name,
		models: report.groups.map((g) => g.model),
		window: { before: segment.before.at, after: segment.after.at },
		provider: { promptTokens: segment.delta.promptTokens, completionTokens: segment.delta.completionTokens, requests: segment.delta.requests, days: segment.days },
		analyzer,
		difference: {
			promptTokens: analyzer.promptTokens - segment.delta.promptTokens,
			promptShare: pct(analyzer.promptTokens, segment.delta.promptTokens),
			outputTokens: analyzer.outputTokens - segment.delta.completionTokens,
			outputShare: pct(analyzer.outputTokens, segment.delta.completionTokens),
		},
	};
}

function usageMarkdown(usage) {
	const n = (v) => (v === null || v === undefined ? "-" : v.toLocaleString("en-US"));
	const share = (v) => (v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
	const rows = usage.batches.map((b) => `| ${b.batch} | ${b.models.join(", ")} | ${b.analyzer.sessions} | ${n(b.provider?.promptTokens)} | ${n(b.analyzer.promptTokens)} | ${share(b.difference?.promptShare)} | ${n(b.provider?.completionTokens)} | ${n(b.analyzer.outputTokens)} | ${share(b.difference?.outputShare)} | ${n(b.provider?.requests)} | ${b.analyzer.zeroUsageTurns} |`);
	return [
		"# Usage control: provider usage endpoint versus the session analyzer",
		"",
		"| Batch | Models | Sessions | Provider prompt | Analyzer prompt | Prompt diff | Provider completion | Analyzer output | Output diff | Provider requests | Zero-usage turns |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"Provider: difference between the usage endpoint readings logged before and after the batch (`usage-before` / `usage-after` in the batch's progress.log), for the batch model only. " +
			"Analyzer: sum over the batch sessions of input + cache read + cache write (prompt) and output, parent plus children, from each run's analysis.json. " +
			"Diff: (analyzer - provider) / provider.",
		"",
	].join("\n");
}

function agreementMarkdown(agreement, labels) {
	const rate = (v) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
	const lines = [
		"# Calibration: judge versus independent reference",
		"",
		`Judge: ${labels.judge}. Reference: ${labels.reference}. Sample: ${agreement.answers} answers.`,
		"",
		"| Measure | Compared | Agree | Rate | Other |",
		"|---|---|---|---|---|",
		`| Key facts (supported) | ${agreement.facts.compared} | ${agreement.facts.agree} | ${rate(agreement.facts.rate)} | Cohen's kappa ${agreement.facts.kappa === null ? "-" : agreement.facts.kappa.toFixed(3)} |`,
		`| Forbidden claims (present) | ${agreement.forbidden.compared} | ${agreement.forbidden.agree} | ${rate(agreement.forbidden.rate)} | |`,
		`| Reply language | ${agreement.language.compared} | ${agreement.language.agree} | ${rate(agreement.language.compared ? agreement.language.agree / agreement.language.compared : null)} | |`,
		`| Answer score | ${agreement.answers} | | | Pearson ${agreement.score.pearson === null ? "-" : agreement.score.pearson.toFixed(3)}, mean absolute difference ${agreement.score.meanAbsDiff === null ? "-" : agreement.score.meanAbsDiff.toFixed(3)} |`,
		"",
		`Reference verdicts: ${labels.referenceCounts.supported} facts supported, ${labels.referenceCounts.unsupported} not supported; ${labels.referenceCounts.forbiddenPresent} forbidden claims present.`,
		`Disagreements: ${agreement.disagreements.length}.`,
		"",
	];
	return lines.join("\n");
}

function referenceCounts(sample) {
	const facts = sample.entries.flatMap((e) => e.facts ?? []);
	return {
		supported: facts.filter((f) => f.supported === true).length,
		unsupported: facts.filter((f) => f.supported === false).length,
		forbiddenPresent: sample.entries.flatMap((e) => e.forbidden ?? []).filter((f) => f.present === true).length,
	};
}

function indexMarkdown(batches, sampleSize) {
	return [
		"# Results",
		"",
		"Aggregated, privacy-safe results of the delegation benchmark. Generated by `node scripts/export-results.mjs` from the gitignored `.bench/` directory; do not edit by hand. " +
			"No raw session file, event log, agent home or package copy is included, and no absolute path. The method is in [`docs/METHODOLOGY.md`](../docs/METHODOLOGY.md) and the reading of these numbers in [`docs/RESULTS.md`](../docs/RESULTS.md).",
		"",
		"| Path | Content |",
		"|---|---|",
		...batches.map((b) => `| [\`batches/${b.name}.md\`](batches/${b.name}.md), \`.json\` | Batch report (\`report.mjs\`): cost per arm under NaN and API weights, delegation, parent context, wall time, evidence-budget adherence, reply language; the JSON keeps every per-session row. |`),
		"| [`provenance.md`](provenance.md), `.json` | Gentle Shell package commit and version, donor commit and run settings per batch, from the run manifests. |",
		"| [`usage-control.md`](usage-control.md), `.json` | Provider usage endpoint delta per batch next to the analyzer totals. |",
		"| [`grading/summary.md`](grading/summary.md), `summary.json` | Grade summary per batch, model and arm (`grade.mjs`). |",
		"| [`grading/grades.jsonl`](grading/grades.jsonl) | One line per graded answer: verdict per key fact and forbidden claim, score, language, judge usage, run id, arm, model, replicate, turn. No answer text. |",
		`| [\`calibration/sample.json\`](calibration/sample.json) | The blind calibration sample: ${sampleSize} answers with question, answer text, key facts and forbidden claims, verdicts empty. |`,
		"| [`calibration/reference.json`](calibration/reference.json) | The same sample graded by an independent reference. |",
		"| [`calibration/judge.json`](calibration/judge.json) | The same sample graded by the judge used for all answers. |",
		"| [`calibration/agreement.md`](calibration/agreement.md), `.json` | Judge versus reference agreement. |",
		"| [`quality.md`](quality.md), `quality.json` | Paired score differences between arms with bootstrap 95% intervals. |",
		"",
	].join("\n");
}

/**
 * options: benchDir (the .bench directory), outDir, repoRoot, home (scanned
 * for; default the user's home), batches [{name, selector, log, logModel}]
 * (log relative to benchDir), calibration {sample, reference, judge} (relative
 * to benchDir), grading (directory relative to benchDir, default "grading").
 * Returns {files}: the written paths relative to outDir, sorted.
 */
export async function exportResults({ benchDir, outDir, repoRoot, home = homedir(), batches, calibration, grading = "grading" }) {
	benchDir = resolve(benchDir);
	outDir = resolve(outDir);
	repoRoot = resolve(repoRoot);
	const clean = (value) => relativizePaths(value, { repoRoot, benchDir });
	const outputs = new Map();
	const put = (path, text) => outputs.set(path, text);

	const usage = { schemaVersion: EXPORT_SCHEMA_VERSION, batches: [] };
	const provenance = { schemaVersion: EXPORT_SCHEMA_VERSION, batches: [] };
	for (const batch of batches) {
		const report = clean(await buildReport({ runsRoot: join(benchDir, "runs"), selector: batch.selector }));
		put(`batches/${batch.name}.json`, json(report));
		put(`batches/${batch.name}.md`, renderMarkdown(report));
		const segments = batch.log ? parseUsageLog(await readFile(join(benchDir, batch.log), "utf8")) : [];
		usage.batches.push(usageEntry(batch, report, segments));
		provenance.batches.push(await provenanceEntry(benchDir, batch));
	}
	put("provenance.json", json(provenance));
	put("provenance.md", provenanceMarkdown(provenance));
	put("usage-control.json", json(usage));
	put("usage-control.md", usageMarkdown(usage));

	const gradesText = await readFile(join(benchDir, grading, "grades.jsonl"), "utf8");
	const records = gradesText.split("\n").filter((line) => line.trim()).map((line, index) => {
		const record = JSON.parse(line);
		const key = findTextKey(record);
		if (key) throw new Error(`grades.jsonl line ${index + 1} carries answer text (${key}); refusing to export it`);
		return clean(record);
	});
	put("grading/grades.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	put("grading/summary.json", json(clean(JSON.parse(await readFile(join(benchDir, grading, "summary.json"), "utf8")))));
	put("grading/summary.md", clean(await readFile(join(benchDir, grading, "summary.md"), "utf8")));

	const readJson = async (path) => clean(JSON.parse(await readFile(join(benchDir, path), "utf8")));
	const sample = await readJson(calibration.sample);
	const reference = await readJson(calibration.reference);
	const judge = await readJson(calibration.judge);
	put("calibration/sample.json", json(sample));
	put("calibration/reference.json", json(reference));
	put("calibration/judge.json", json(judge));
	const agreement = computeAgreement(judge, reference);
	put("calibration/agreement.json", json({ judge: judge.judgeModel ?? null, reference: "calibration/reference.json", ...agreement }));
	put("calibration/agreement.md", agreementMarkdown(agreement, { judge: judge.judgeModel ?? "judge", reference: "independent reference (calibration/reference.json)", referenceCounts: referenceCounts(reference) }));

	const quality = qualityComparisons(records);
	put("quality.json", json(quality));
	put("quality.md", renderQualityMarkdown(quality));
	put("README.md", indexMarkdown(batches, sample.entries.length));

	const leaks = [];
	for (const [path, text] of outputs) for (const match of new Set(findHomePaths(text, { home }))) leaks.push(`${path}: ${match}`);
	if (leaks.length) throw new Error(`absolute paths under a home directory would be exported; nothing was written:\n  ${leaks.join("\n  ")}`);

	for (const [path, text] of outputs) {
		await mkdir(dirname(join(outDir, path)), { recursive: true });
		await writeFile(join(outDir, path), text);
	}
	// Scan what landed on disk too, so the check covers the written bytes.
	const written = [...outputs.keys()].sort();
	for (const path of written) {
		const found = findHomePaths(await readFile(join(outDir, path), "utf8"), { home });
		if (found.length) throw new Error(`${path}: ${found[0]} (absolute path under a home directory in the written file)`);
	}
	return { files: written };
}
