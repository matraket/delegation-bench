// Provider usage control from a batch's progress.log. The batch scripts log
// the provider's usage endpoint before and after the batch:
//   <utc> [<model> ]usage-before <json>
//   <utc> [<model> ]usage-after <json>
// where <json> is either an array of per-day records
// ({date, prompt_tokens, completion_tokens, api_requests}) or one object
// ({days, prompt_tokens, completion_tokens, api_requests}) already summed over
// the days of the batch. Every other line is ignored.

const LINE = /^(\S+) (?:(\S+) )?usage-(before|after) (.*)$/;

function totals(json) {
	const data = JSON.parse(json);
	const records = Array.isArray(data) ? data : [data];
	const days = Array.isArray(data) ? data.map((d) => d.date) : [...(data.days ?? [])];
	const add = (field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);
	return { promptTokens: add("prompt_tokens"), completionTokens: add("completion_tokens"), requests: add("api_requests"), days };
}

/** One segment per before/after pair, in log order: {model, before, after, delta, days}. */
export function parseUsageLog(text) {
	const segments = [];
	const open = new Map();
	for (const line of text.split("\n")) {
		const match = LINE.exec(line.trim());
		if (!match) continue;
		const [, at, model = null, phase, json] = match;
		const reading = { at, ...totals(json) };
		if (phase === "before") {
			open.set(model, reading);
			continue;
		}
		const before = open.get(model);
		if (!before) throw new Error(`usage-after without a usage-before${model ? ` for ${model}` : ""} at ${at}`);
		open.delete(model);
		segments.push({
			model,
			before,
			after: reading,
			delta: { promptTokens: reading.promptTokens - before.promptTokens, completionTokens: reading.completionTokens - before.completionTokens, requests: reading.requests - before.requests },
			days: [...new Set([...before.days, ...reading.days])].sort(),
		});
	}
	return segments;
}
