// Run an async function over items with at most `limit` calls in flight.
// Results keep the input order.
export async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await fn(items[index], index);
		}
	};
	const width = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: width }, worker));
	return results;
}
