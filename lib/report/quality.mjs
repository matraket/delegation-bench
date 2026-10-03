// Paired answer-quality comparison between arms: for each pair of arms, the
// per-turn score difference over answers to the same turn in the same batch,
// model and replicate, with a bootstrap 95% confidence interval and a sign
// count. Ported from the T7.3 prototype (.bench/analysis/quality-diff.mjs);
// the comparison order, the random stream and the arithmetic are kept so the
// numbers match it exactly.

export const QUALITY_SEED = 5139;
export const BOOTSTRAP_ITERATIONS = 5000;

/**
 * The prototype's random stream: x = (x * 1103515245 + 12345) mod 2^31, in
 * double arithmetic (the product exceeds 2^53, so this is not an exact LCG,
 * but it is deterministic and reproduces the published intervals).
 */
export function prototypeRandom(seed = QUALITY_SEED) {
	let state = seed;
	return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Grade records with a judge verdict: a score, no error, not skipped. */
export function gradedRows(records) {
	return records.filter((r) => r.score !== null && r.score !== undefined && !r.error && !r.skipped);
}

const pairKey = (r) => `${r.batch}|${r.model}|${r.turnId}|${r.replicate ?? 1}`;

/** arm -> Map(pair key -> record); a later record with the same key replaces an earlier one. */
export function indexByArm(rows) {
	const byArm = new Map();
	for (const r of rows) {
		if (!byArm.has(r.arm)) byArm.set(r.arm, new Map());
		byArm.get(r.arm).set(pairKey(r), r);
	}
	return byArm;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Percentile bootstrap of the mean: [2.5th, 97.5th] of `iterations` resampled means. */
export function bootstrapCI(diffs, rand, iterations = BOOTSTRAP_ITERATIONS) {
	const means = [];
	for (let i = 0; i < iterations; i += 1) means.push(mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(rand() * diffs.length)])));
	means.sort((x, y) => x - y);
	return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

/** Score of arm `a` minus score of arm `b` over paired answers; `filter` applies to the `a` answer. */
export function compareArms(byArm, a, b, { filter = () => true, subset = "all", rand = prototypeRandom(), iterations = BOOTSTRAP_ITERATIONS } = {}) {
	const diffs = [];
	let worse = 0;
	let better = 0;
	let ties = 0;
	const left = byArm.get(a) ?? new Map();
	const right = byArm.get(b) ?? new Map();
	for (const [key, ra] of left) {
		const rb = right.get(key);
		if (!rb || !filter(ra)) continue;
		const d = ra.score - rb.score;
		diffs.push(d);
		if (d < 0) worse += 1;
		else if (d > 0) better += 1;
		else ties += 1;
	}
	if (diffs.length === 0) return { a, b, subset, n: 0, meanDiff: null, ci95: null, worse, better, ties };
	return { a, b, subset, n: diffs.length, meanDiff: mean(diffs), ci95: bootstrapCI(diffs, rand, iterations), worse, better, ties };
}

const isLong = (r) => r.kind === "long" || String(r.batch).startsWith("long");

/**
 * The study's comparison set, in the prototype's order (one random stream is
 * shared across comparisons, so the order matters): delegate against each
 * other arm, the two inline-rule arms against inline, then delegate against
 * inline by question size, follow-up, model (first-seen order) and session length.
 */
export function qualityComparisons(records, { seed = QUALITY_SEED, iterations = BOOTSTRAP_ITERATIONS } = {}) {
	const rows = gradedRows(records);
	const byArm = indexByArm(rows);
	const rand = prototypeRandom(seed);
	const compare = (a, b, subset = "all", filter = undefined) => compareArms(byArm, a, b, { subset, filter, rand, iterations });
	const comparisons = [];
	for (const b of ["inline", "shipped", "old-rules"]) comparisons.push(compare("delegate", b));
	comparisons.push(compare("shipped", "inline"));
	comparisons.push(compare("old-rules", "inline"));
	for (const size of ["small", "medium", "large"]) comparisons.push(compare("delegate", "inline", `size=${size}`, (r) => r.size === size));
	comparisons.push(compare("delegate", "inline", "follow-ups", (r) => r.followup));
	comparisons.push(compare("delegate", "inline", "first questions", (r) => !r.followup));
	for (const model of [...new Set(rows.map((r) => r.model))]) comparisons.push(compare("delegate", "inline", `model=${model}`, (r) => r.model === model));
	comparisons.push(compare("delegate", "inline", "long sessions", isLong));
	comparisons.push(compare("delegate", "inline", "short sessions", (r) => !isLong(r)));
	const judgeUsage = rows.reduce((u, r) => ({ promptTokens: u.promptTokens + (r.usage?.promptTokens ?? 0), completionTokens: u.completionTokens + (r.usage?.completionTokens ?? 0) }), { promptTokens: 0, completionTokens: 0 });
	return { seed, iterations, graded: rows.length, judgeUsage, comparisons };
}

const fixed = (value) => (value === null ? "-" : value.toFixed(3));

export function renderQualityMarkdown(result) {
	const rows = result.comparisons.map((c) => `| ${c.a} - ${c.b} | ${c.subset} | ${c.n} | ${fixed(c.meanDiff)} | ${c.ci95 ? `[${fixed(c.ci95[0])}, ${fixed(c.ci95[1])}]` : "-"} | ${c.worse} | ${c.better} | ${c.ties} |`);
	return [
		"# Answer quality: paired score differences",
		"",
		`Graded answers: ${result.graded}. Bootstrap: ${result.iterations} resamples, seed ${result.seed}.`,
		"",
		"| Comparison (A - B) | Subset | Pairs | Mean difference | 95% CI | A worse | A better | Ties |",
		"|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"Score: supported key facts / total key facts per answer. A pair is two answers to the same turn in the same batch, model and replicate, one from each arm. " +
			"Mean difference: mean of A score - B score over the pairs (negative means A covered fewer facts). 95% CI: percentile bootstrap of that mean. " +
			"Subsets filter on the A answer.",
		"",
	].join("\n");
}
