// Run an async function over items with at most `limit` calls in flight.
// Results keep the input order. When one call throws, no worker takes a new
// item; calls already in flight finish, and the first error is rethrown.
export async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && next < items.length) {
			const index = next;
			next += 1;
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	const width = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: width }, worker));
	return results;
}
