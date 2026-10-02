// Judge backend selection by the `--judge` spec prefix:
//   nan/<model>              OpenAI-compatible HTTP on NaN Builders (needs NAN_API_KEY)
//   pi/<provider>/<model>    plain `pi -p` with pi's own login (no NAN_API_KEY)
// The full spec is the judge model name in records and in the cache key, so
// different judges never share cached judgments.

const SPEC_ERROR = "--judge must be nan/<model> or pi/<provider>/<model>";

export function parseJudgeSpec(spec) {
	const [prefix, ...rest] = String(spec).split("/");
	if (prefix === "nan" && rest.length >= 1 && rest.every(Boolean)) return { backend: "nan", spec, model: spec };
	if (prefix === "pi" && rest.length >= 2 && rest.every(Boolean)) return { backend: "pi", spec, model: rest.join("/") };
	throw new Error(`${SPEC_ERROR} (got ${JSON.stringify(spec)})`);
}

/** Judge calls in flight when --concurrency is not given: one pi process at a time, two HTTP requests. */
export function defaultConcurrency(backend) {
	return backend === "pi" ? 1 : 2;
}
