// Split a parent session into user turns (prompt to next prompt) and measure
// what the parent itself read in each one. Definitions follow the T5/T6
// prototypes: evidence = tool-result text chars / 4, a tool round = an
// assistant message with at least one tool call, the answer = the last
// non-empty assistant text before the next user message.

export const EVIDENCE_BUDGET_TOKENS = 10000;
export const ROUND_BUDGET = 5;

const textOf = (content, type = "text") => (content ?? []).filter((c) => c.type === type).map((c) => c.text ?? "").join("\n");

export function userTurns(entries) {
	const turns = [];
	let current = null;
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message ?? {};
		const content = Array.isArray(message.content) ? message.content : [];
		if (message.role === "user") {
			current = { prompt: textOf(content), rounds: 0, chars: 0, text: "" };
			turns.push(current);
		} else if (current && message.role === "assistant") {
			if (content.some((c) => c.type === "toolCall")) current.rounds += 1;
			const text = textOf(content);
			if (text.trim()) current.text = text;
		} else if (current && message.role === "toolResult") {
			current.chars += content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
		}
	}
	for (const turn of turns) turn.evidenceTokens = Math.round(turn.chars / 4);
	return turns;
}

/** Over the evidence budget: more than 10k tokens read or more than 5 tool rounds in one user turn. */
export function overBudget(turn) {
	return turn.chars / 4 > EVIDENCE_BUDGET_TOKENS || turn.rounds > ROUND_BUDGET;
}
