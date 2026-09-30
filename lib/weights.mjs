// Weight profiles turn raw token counts into one comparable cost number.
// A profile weighs each of the four billed token kinds; the unit is
// "input-token equivalents", not money.

export const WEIGHT_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

export const BUILTIN_PROFILES = Object.freeze({
	// Anthropic-style API pricing ratios: cached reads are cheap, cache writes
	// carry a premium, output is five times input.
	api: Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }),
	// NaN Builders quota accounting: cached reads count 1:1 and cache writes
	// are not reported.
	nan: Object.freeze({ input: 1, cacheRead: 1, cacheWrite: 0, output: 1 }),
});

/** Weighted cost of a token bundle, rounded to 6 decimals to hide float noise. */
export function weightedCost(tokens, weights) {
	let total = 0;
	for (const key of WEIGHT_KEYS) total += (tokens[key] ?? 0) * weights[key];
	return Math.round(total * 1e6) / 1e6;
}

function parseCustom(json) {
	let parsed;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error(`--weights must be a JSON object, got: ${json}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--weights must be a JSON object");
	const name = parsed.name ?? "custom";
	if (typeof name !== "string" || name.length === 0) throw new Error("--weights name must be a non-empty string");
	const weights = {};
	for (const key of WEIGHT_KEYS) {
		if (typeof parsed[key] !== "number" || !Number.isFinite(parsed[key])) throw new Error(`--weights needs a finite number for "${key}"`);
		weights[key] = parsed[key];
	}
	return { name, weights };
}

/**
 * Resolve the profiles to report, in a stable order.
 * - names: explicit profile names (undefined means "api, nan" plus the custom one if given)
 * - customJson: optional JSON object with the four weights and an optional name
 */
export function selectProfiles(names, customJson) {
	const available = { ...BUILTIN_PROFILES };
	let customName;
	if (customJson !== undefined) {
		const custom = parseCustom(customJson);
		available[custom.name] = custom.weights;
		customName = custom.name;
	}
	const wanted = names ?? ["api", "nan", ...(customName && !(customName in BUILTIN_PROFILES) ? [customName] : [])];
	const selected = {};
	for (const name of wanted) {
		if (!(name in available)) throw new Error(`unknown weight profile: ${name}`);
		selected[name] = { ...available[name] };
	}
	return selected;
}
