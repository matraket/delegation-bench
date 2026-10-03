// Privacy helpers for exported results: make absolute paths relative and find
// any path under a home directory that survived.

/**
 * Deep copy of `value` where every string occurrence of `benchDir` becomes
 * `.bench` and of `repoRoot` becomes `.` (a following `/` is dropped for the
 * repository root, so `<repo>/questions/x.json` becomes `questions/x.json`).
 * The longer prefix is replaced first.
 */
export function relativizePaths(value, { repoRoot, benchDir }) {
	const rules = [
		{ prefix: benchDir, nested: ".bench/", exact: ".bench" },
		{ prefix: repoRoot, nested: "", exact: "." },
	].filter((rule) => rule.prefix).sort((x, y) => y.prefix.length - x.prefix.length);
	const fixString = (text) => {
		for (const rule of rules) {
			if (text === rule.prefix) return rule.exact;
			text = text.replaceAll(`${rule.prefix}/`, rule.nested);
		}
		return text;
	};
	const walk = (node) => {
		if (typeof node === "string") return fixString(node);
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
		return node;
	};
	return walk(value);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATH_TAIL = String.raw`[^\s"'\`)<>,;]*`;

/**
 * Paths under a home directory found in `text`: the given `home` (exact or
 * followed by `/`), and any path inside a user directory under `/home` or `/Users`.
 */
export function findHomePaths(text, { home } = {}) {
	const patterns = [String.raw`/(?:home|Users)/[A-Za-z0-9._-]+/${PATH_TAIL}`];
	if (home && home !== "/") patterns.unshift(`${escapeRegExp(home)}(?![A-Za-z0-9._-])${PATH_TAIL}`);
	const found = [];
	const regex = new RegExp(patterns.join("|"), "g");
	for (const match of text.matchAll(regex)) found.push(match[0]);
	return found;
}
