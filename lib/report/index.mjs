// Batch report: discover runs for a selector, compute per-session metrics and
// aggregates, and write JSON plus Markdown.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateGroup } from "./aggregate.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { sessionMetrics } from "./metrics.mjs";
import { discoverRuns, loadRun } from "./runs.mjs";
import { sum } from "./stats.mjs";

export const REPORT_SCHEMA_VERSION = 1;

export async function buildReport({ runsRoot, selector }) {
	const runs = await discoverRuns(runsRoot, selector);
	if (runs.length === 0) throw new Error(`no runs match "${selector}" under ${runsRoot}`);
	const sessions = [];
	for (const run of runs) sessions.push(sessionMetrics(await loadRun(run)));
	const models = [...new Set(sessions.map((s) => s.model))].sort();
	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		selector,
		runsRoot,
		sessionCount: sessions.length,
		turnsSettled: sum(sessions.map((s) => s.turnsSettled)),
		totals: {
			prompt: sum(sessions.map((s) => s.prompt)),
			output: sum(sessions.map((s) => s.output)),
			zeroUsageTurns: sum(sessions.map((s) => s.zeroUsageTurns)),
			statuses: [...new Set(sessions.map((s) => s.status))],
		},
		groups: models.map((model) => aggregateGroup(sessions.filter((s) => s.model === model))),
		sessions,
	};
}

/** File stem for a selector: trailing dashes dropped, glob and path characters replaced. */
export function batchSlug(selector) {
	return selector.replace(/-+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "batch";
}

export async function writeReport(report, outDir) {
	await mkdir(outDir, { recursive: true });
	const stem = join(outDir, batchSlug(report.selector));
	const markdown = renderMarkdown(report);
	await writeFile(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(`${stem}.md`, markdown);
	return { json: `${stem}.json`, markdown: `${stem}.md`, text: markdown };
}
