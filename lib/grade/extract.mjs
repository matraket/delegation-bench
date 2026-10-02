// Final parent answers per user turn: the last non-empty assistant text before
// the next user message, mapped to the manifest turn id by position. The sent
// prompt is kept so the grader can verify the mapping against the key.
import { createHash } from "node:crypto";
import { userTurns } from "../report/turns.mjs";

export function extractAnswers({ manifest, entries }) {
	return userTurns(entries).map((turn, index) => {
		const planned = manifest.turns?.[index];
		return {
			turnId: planned?.id ?? null,
			turnIndex: index,
			turnStatus: planned?.status ?? null,
			prompt: turn.prompt,
			answer: turn.text,
			promptMatches: planned?.prompt === undefined ? null : planned.prompt === turn.prompt,
		};
	});
}

/** Stable blind id of one answer: hash of turn id and answer text only. */
export function answerKey(turnId, answer) {
	return createHash("sha256").update(`${turnId}\n${answer}`).digest("hex").slice(0, 16);
}
