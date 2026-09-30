// Human-readable table rendering of an analyzeSessions() report.

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function num(value) {
	return value === null || value === undefined ? "-" : integer.format(value);
}

function align(rows, leftColumns = 3) {
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
	return rows.map((row) => row.map((cell, column) => {
		const text = String(cell);
		return column < leftColumns ? text.padEnd(widths[column]) : text.padStart(widths[column]);
	}).join("  ").trimEnd());
}

function sessionRow(role, id, agent, metrics, handoff, profileNames) {
	return [
		role,
		id ?? "-",
		agent ?? "-",
		num(metrics.turns),
		num(metrics.zeroUsageTurns),
		num(metrics.tokens.input),
		num(metrics.tokens.cacheRead),
		num(metrics.tokens.cacheWrite),
		num(metrics.tokens.output),
		num(metrics.firstPrefix),
		num(metrics.peakPrompt),
		num(metrics.finalContext),
		handoff,
		...profileNames.map((name) => decimal.format(metrics.cost[name])),
	];
}

function renderParent(report, profileNames) {
	const header = ["role", "session", "agent", "turns", "zero", "input", "cacheRead", "cacheWrite", "output", "first", "peak", "final", "handoff~", ...profileNames.map((name) => `cost:${name}`)];
	const rows = [header, sessionRow("parent", report.session.id, "-", report.session, "-", profileNames)];
	for (const child of report.children) rows.push(sessionRow("child", child.id, child.agent, child, num(child.handoffTokens), profileNames));
	const empty = { firstPrefix: null, peakPrompt: null, finalContext: null };
	if (report.children.length > 0) rows.push(sessionRow("CHILDREN", `${report.children.length} sessions`, "-", { ...report.totals.children, ...empty }, num(report.totals.children.handoffTokens), profileNames));
	rows.push(sessionRow("TOTAL", `${report.totals.sessions} sessions`, "-", { ...report.totals, ...empty }, "-", profileNames));

	const lines = [`Parent ${report.session.id}  ${report.session.path}`];
	lines.push(`Models: ${report.session.models.map((m) => `${m.model} (${m.turns})`).join(", ") || "-"}`);
	for (const child of report.children) lines.push(`  child ${child.id}: ${child.models.map((m) => `${m.model} (${m.turns})`).join(", ") || "-"}; tasks ${child.tasks.map((t) => `${t.taskId}/${t.status}`).join(", ")}`);
	lines.push("", ...align(rows));
	if (report.unresolvedTasks.length > 0) {
		lines.push("", "Unresolved tasks (no child session file; not in totals):");
		lines.push(...align([["task", "reason", "agent", "status"], ...report.unresolvedTasks.map((t) => [t.taskId, t.reason, t.agent ?? "-", t.status ?? "-"])], 4).map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

export function formatTable(result) {
	const profileNames = Object.keys(result.profiles);
	const legend = `Profiles: ${profileNames.map((name) => {
		const w = result.profiles[name];
		return `${name} (in ${w.input}, cacheRead ${w.cacheRead}, cacheWrite ${w.cacheWrite}, out ${w.output})`;
	}).join("; ")}. first/peak/final = prompt tokens (input+cacheRead+cacheWrite); zero = turns without billed usage; handoff~ = estimated tokens.`;
	return [...result.parents.map((report) => renderParent(report, profileNames)), legend].join("\n\n") + "\n";
}
