// Markdown tables in the style of the feature document (T5/T6 tables).

/** Cost-like totals: 4.84M, 286k, 950. */
export function fmtCost(value) {
	if (value === null || value === undefined) return "-";
	if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
	if (Math.abs(value) >= 1e3) return `${Math.round(value / 1e3)}k`;
	return String(Math.round(value));
}

/** Context sizes: 36.2k, 156.6k. */
export function fmtContext(value) {
	if (value === null || value === undefined) return "-";
	return value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
}

const fmtRange = (s) => (s.min === null ? "-" : s.max >= 1e6 ? `${(s.min / 1e6).toFixed(2)}-${(s.max / 1e6).toFixed(2)}M` : `${fmtCost(s.min)}-${fmtCost(s.max)}`);
const fmtRatio = (r) => (r === null || r === undefined ? "-" : `${r.toFixed(2)}x`);
const fmtWall = (seconds, long) => (seconds === null ? "-" : long ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`);

function table(header, rows) {
	return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function shortTable(arms) {
	return table(
		["Arm", "Sessions that delegated", "Children", "NaN total", "NaN median", "Median vs inline", "API median", "Final parent context (median)", "Wall (median)", "Turns over budget", "Max evidence"],
		arms.filter((a) => a.sessions).map((a) => [
			a.arm, a.delegatedSessions, a.children, fmtCost(a.nan.total), fmtCost(a.nan.median), fmtRatio(a.ratioVsInline), fmtCost(a.api.median),
			fmtContext(a.final.median), fmtWall(a.wallSeconds.median, false), `${a.overBudgetTurns}/${a.userTurns}`, fmtContext(a.maxEvidence),
		]),
	);
}

function longTable(arms) {
	return table(
		["Arm", "Reps that delegated", "Children", "NaN median (min-max)", "API-weight median", "Peak parent context (median)", "Final parent context (median)", "Wall (median)", "Turns over budget", "Spanish turns (late)"],
		arms.filter((a) => a.sessions).map((a) => [
			a.arm, `${a.delegatedSessions}/${a.sessions}`, a.children, `${fmtCost(a.nan.median)} (${fmtRange(a.nan)})`, fmtCost(a.api.median),
			fmtContext(a.peak.median), fmtContext(a.final.median), fmtWall(a.wallSeconds.median, true), `${a.overBudgetTurns}/${a.userTurns}`,
			`${a.language.es} (${a.language.esLate})`,
		]),
	);
}

function sizeTable(sizes) {
	return table(
		["Size", "Arm", "Sessions", "Delegated", "NaN median", "Median vs inline", "Final parent context (median)", "Turns over budget", "Spanish turns"],
		sizes.map((s) => [s.size, s.arm, s.sessions, s.delegatedSessions, fmtCost(s.nan.median), fmtRatio(s.ratioVsInline), fmtContext(s.final.median), `${s.overBudgetTurns}/${s.userTurns}`, s.language.es]),
	);
}

export function summaryLine(report) {
	const t = report.totals;
	return `${report.selector}: ${report.sessionCount} sessions, statuses ${t.statuses.join(",")}, turns settled ${report.turnsSettled}, prompt ${t.prompt}, output ${t.output}, zero-usage turns ${t.zeroUsageTurns}`;
}

export function renderMarkdown(report) {
	const parts = [`# Report ${report.selector}`, "", summaryLine(report)];
	for (const group of report.groups) {
		parts.push("", `## ${group.model} (${group.kind}, ${group.sessions} sessions)`, "", group.kind === "short" ? shortTable(group.arms) : longTable(group.arms));
		if (group.sizes.length) parts.push("", `### By question size`, "", sizeTable(group.sizes));
	}
	parts.push(
		"",
		"Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). " +
			"Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. " +
			"Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.",
	);
	return `${parts.join("\n")}\n`;
}
