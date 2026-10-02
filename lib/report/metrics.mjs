// Per-session metrics from one loaded run (manifest, analysis.json, session).
import { detectLanguage } from "./language.mjs";
import { overBudget, userTurns } from "./turns.mjs";

/** Turns from index LATE_TURN on count as late (language drift in long sessions). */
export const LATE_TURN = 12;

export function sessionMetrics(run) {
	const { manifest, analysis, meta } = run;
	const parent = analysis.parents[0];
	const t = parent.totals.tokens;
	const turns = userTurns(run.entries).map((turn, index) => ({
		index,
		id: manifest.turns?.[index]?.id ?? null,
		status: manifest.turns?.[index]?.status ?? null,
		evidenceTokens: turn.evidenceTokens,
		rounds: turn.rounds,
		overBudget: overBudget(turn),
		language: detectLanguage(turn.text),
		late: index >= LATE_TURN,
	}));
	return {
		...meta,
		status: manifest.status ?? null,
		turnsSettled: (manifest.turns ?? []).filter((turn) => turn.status === "settled").length,
		delegated: parent.children.length > 0,
		children: parent.children.length,
		nan: parent.totals.cost.nan ?? null,
		api: parent.totals.cost.api ?? null,
		parentNan: parent.session.cost?.nan ?? null,
		prompt: t.input + t.cacheRead + t.cacheWrite,
		output: t.output,
		zeroUsageTurns: parent.totals.zeroUsageTurns ?? 0,
		peak: parent.session.peakPrompt ?? null,
		final: parent.session.finalContext ?? null,
		wallSeconds: (manifest.turns ?? []).reduce((total, turn) => total + (turn.durationMs ?? 0), 0) / 1000,
		userTurns: turns.length,
		overBudgetTurns: turns.filter((turn) => turn.overBudget).length,
		maxEvidence: Math.max(0, ...turns.map((turn) => turn.evidenceTokens)),
		turns,
	};
}
