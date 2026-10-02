// Aggregates over per-session rows: per model group and arm, and per question
// size for short batches, with the per-question median ratio versus inline.
import { ARMS } from "./runs.mjs";
import { median, minMax, sum } from "./stats.mjs";

const spread = (values) => ({ total: sum(values), median: median(values), ...minMax(values) });

function armStats(rows, arm, ratio) {
	const turns = rows.flatMap((r) => r.turns);
	return {
		arm,
		sessions: rows.length,
		delegatedSessions: rows.filter((r) => r.delegated).length,
		children: sum(rows.map((r) => r.children)),
		nan: spread(rows.map((r) => r.nan)),
		api: spread(rows.map((r) => r.api)),
		parentNan: spread(rows.map((r) => r.parentNan ?? 0)),
		prompt: sum(rows.map((r) => r.prompt)),
		output: sum(rows.map((r) => r.output)),
		zeroUsageTurns: sum(rows.map((r) => r.zeroUsageTurns)),
		peak: { median: median(rows.map((r) => r.peak)), ...minMax(rows.map((r) => r.peak)) },
		final: { median: median(rows.map((r) => r.final)), ...minMax(rows.map((r) => r.final)) },
		wallSeconds: spread(rows.map((r) => r.wallSeconds)),
		userTurns: turns.length,
		overBudgetTurns: turns.filter((t) => t.overBudget).length,
		maxEvidence: Math.max(0, ...rows.map((r) => r.maxEvidence)),
		language: {
			en: turns.filter((t) => t.language === "en").length,
			es: turns.filter((t) => t.language === "es").length,
			esLate: turns.filter((t) => t.language === "es" && t.late).length,
			none: turns.filter((t) => t.language === null).length,
		},
		ratioVsInline: ratio,
	};
}

/** Median over questions of arm cost / inline cost (NaN weights); null without pairs. */
function ratioVsInline(rows, arm) {
	const questions = [...new Set(rows.map((r) => r.question))];
	const get = (q, a) => rows.find((r) => r.question === q && r.arm === a);
	const ratios = questions.filter((q) => get(q, arm) && get(q, "inline")).map((q) => get(q, arm).nan / get(q, "inline").nan);
	return median(ratios);
}

const armOrder = (rows) => [...ARMS, ...[...new Set(rows.map((r) => r.arm))].filter((a) => !ARMS.includes(a)).sort()];

export function aggregateGroup(rows) {
	const kinds = [...new Set(rows.map((r) => r.kind))];
	const kind = kinds.length === 1 ? kinds[0] : "mixed";
	const short = kind === "short";
	const arms = armOrder(rows).map((arm) => armStats(rows.filter((r) => r.arm === arm), arm, short ? ratioVsInline(rows, arm) : null));
	const sizes = [];
	if (short) {
		for (const size of ["small", "medium", "large"]) {
			const sized = rows.filter((r) => r.size === size);
			for (const arm of armOrder(rows)) {
				const subset = sized.filter((r) => r.arm === arm);
				if (subset.length) sizes.push({ size, ...armStats(subset, arm, ratioVsInline(sized, arm)) });
			}
		}
	}
	return { model: rows[0]?.model ?? null, kind, sessions: rows.length, arms, sizes };
}
