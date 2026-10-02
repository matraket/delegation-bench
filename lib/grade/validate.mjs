// Strict validation of a judge reply against the key of its turn.

export class JudgmentError extends Error {
	constructor(message) {
		super(`invalid judge response: ${message}`);
		this.name = "JudgmentError";
	}
}

const LANGUAGES = new Set(["en", "es", "other"]);
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

function checkList(value, key, flag, label) {
	if (!Array.isArray(value)) throw new JudgmentError(`"${label}" is not an array`);
	const wanted = key.map((item) => item.id);
	const seen = new Map();
	for (const item of value) {
		if (!item || typeof item !== "object" || typeof item.id !== "string") throw new JudgmentError(`"${label}" has an entry without an id`);
		if (typeof item[flag] !== "boolean") throw new JudgmentError(`${label} ${item.id}: "${flag}" is not a boolean`);
		if (seen.has(item.id)) throw new JudgmentError(`${label} ${item.id} appears twice`);
		if (!wanted.includes(item.id)) throw new JudgmentError(`${label} ${item.id} is not in the key`);
		seen.set(item.id, item[flag]);
	}
	const missing = wanted.filter((id) => !seen.has(id));
	if (missing.length) throw new JudgmentError(`${label} missing: ${missing.join(", ")}`);
	return wanted.map((id) => ({ id, [flag]: seen.get(id) }));
}

/**
 * Parse and validate the judge's reply. The whole content must be one JSON
 * object (a single ```json fence around it is tolerated). Every key id must
 * appear exactly once with a boolean, and nothing else; language is en|es|other.
 */
export function parseJudgment(content, key) {
	if (typeof content !== "string") throw new JudgmentError("content is not text");
	const trimmed = content.trim();
	const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new JudgmentError("not a JSON object");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new JudgmentError("not a JSON object");
	if (!LANGUAGES.has(parsed.language)) throw new JudgmentError(`language ${JSON.stringify(parsed.language)} is not en, es or other`);
	const forbiddenKey = key.forbidden ?? [];
	// An omitted forbidden list is accepted only when the key has no forbidden claims.
	const forbidden = parsed.forbidden ?? (forbiddenKey.length === 0 ? [] : null);
	return {
		facts: checkList(parsed.facts, key.facts, "supported", "facts"),
		forbidden: checkList(forbidden, forbiddenKey, "present", "forbidden"),
		language: parsed.language,
	};
}
