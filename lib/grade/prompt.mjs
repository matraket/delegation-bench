// Blind judge prompt. The judge sees only the question, the answer, the key
// facts and the forbidden claims: never the arm, model, run id or costs.
// Bump PROMPT_VERSION whenever the text below changes (it keys the cache).

export const PROMPT_VERSION = "grade-v1";

export const SYSTEM_PROMPT = [
	"You grade answers to questions about a software repository against an answer key.",
	"You receive a question, the answer to grade, a list of key facts and a list of forbidden claims.",
	"For each key fact, decide whether the answer states it, in any wording. A fact is supported only when the answer clearly makes the same claim, including any specific values, names or conditions in the fact. A vaguer, partial or hedged statement is not supported. Judge only from the answer text; do not use your own knowledge of the repository.",
	"For each forbidden claim, decide whether the answer states or clearly implies it. Mentioning the topic without making the claim is not present.",
	"Report the main language of the answer's prose, ignoring code, identifiers, paths and quoted strings: \"en\" for English, \"es\" for Spanish, \"other\" for anything else.",
	"Reply with one JSON object only, with no text before or after it, in exactly this shape:",
	"{\"facts\":[{\"id\":\"f1\",\"supported\":true}],\"forbidden\":[{\"id\":\"x1\",\"present\":false}],\"language\":\"en\"}",
	"List every key fact id and every forbidden claim id exactly once. Use an empty forbidden array when there are no forbidden claims.",
].join("\n");

const list = (items) => (items.length ? items.map((item) => `- ${item.id}: ${item.text}`).join("\n") : "(none)");

/** Chat messages for one answer. Only these four inputs are read. */
export function buildJudgeMessages({ prompt, answer, facts, forbidden }) {
	const user = [
		"<question>", prompt, "</question>",
		"",
		"<answer>", answer, "</answer>",
		"",
		"Key facts:", list(facts),
		"",
		"Forbidden claims:", list(forbidden),
	].join("\n");
	return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }];
}

/** Rough token estimate of a prompt (chars / 4), used for forecasts only. */
export function estimateTokens(messages) {
	return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}
