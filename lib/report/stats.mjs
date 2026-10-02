// Small numeric helpers shared by the report and grader summaries.

/** Median with the prototype definition: mean of the two middle values; null when empty. */
export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	if (sorted.length === 0) return null;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function sum(values) {
	return values.reduce((total, value) => total + value, 0);
}

export function minMax(values) {
	if (values.length === 0) return { min: null, max: null };
	return { min: Math.min(...values), max: Math.max(...values) };
}

/** Pearson correlation; null when fewer than two pairs or a constant series. */
export function pearson(xs, ys) {
	const n = xs.length;
	if (n < 2 || ys.length !== n) return null;
	const mx = sum(xs) / n;
	const my = sum(ys) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i += 1) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}
