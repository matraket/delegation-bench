// Answer keys of the canonical question set, indexed by turn id: `<id>` is the
// main question, `<id>-followup` its follow-up.
import { readFile } from "node:fs/promises";

export async function loadQuestionSet(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

const entry = (question, turnId, part, followup) => ({
	turnId,
	questionId: question.id,
	size: question.size ?? null,
	followup,
	prompt: part.prompt,
	facts: (part.key?.facts ?? []).map(({ id, text }) => ({ id, text })),
	forbidden: (part.key?.forbidden ?? []).map(({ id, text }) => ({ id, text })),
});

export function buildKeyIndex(set) {
	const index = new Map();
	for (const question of set.questions ?? []) {
		index.set(question.id, entry(question, question.id, question, false));
		if (question.followup) index.set(`${question.id}-followup`, entry(question, `${question.id}-followup`, question.followup, true));
	}
	return index;
}
