#!/usr/bin/env node
// Export the study's privacy-safe aggregated results from .bench/ to results/.
// Reads batch runs, batch progress logs and grading outputs; writes batch
// reports, the usage control, grades without answer text, the calibration
// sample with both sets of verdicts and their agreement, and the paired
// quality comparison. Deterministic: a second run produces the same bytes.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exportResults } from "../lib/export/index.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// The batches of the published study, in report order. `log` is the batch's
// progress.log (relative to the bench directory) with the provider usage
// readings; `logModel` selects the reading pair for one model when a log
// covers several models.
export const STUDY_BATCHES = [
	{ name: "pilot-01", selector: "pilot-01-", log: "pilot-01-logs/progress.log", logModel: null },
	{ name: "pilot-02-deepseek-v4-flash", selector: "pilot-02-deepseek-v4-flash-", log: "pilot-02-logs/progress.log", logModel: "deepseek-v4-flash" },
	{ name: "pilot-02-qwen3.8-flash", selector: "pilot-02-qwen3.8-flash-", log: "pilot-02-logs/progress.log", logModel: "qwen3.8-flash" },
	{ name: "long-01", selector: "long-01-", log: "long-01-logs/progress.log", logModel: null },
	{ name: "long-02", selector: "long-02-", log: "long-02-logs/progress.log", logModel: null },
];

// Calibration inputs, relative to the bench directory.
export const STUDY_CALIBRATION = {
	sample: "grading/calibration-sample.json",
	reference: "grading/reference-claude.json",
	judge: "grading/sample-judgments/pi_openai-codex_gpt-6.1-sol.json",
};

const USAGE = `Usage: scripts/export-results.mjs [options]

Options:
  --bench <dir>   Bench directory with runs/, grading/ and the batch logs (default .bench)
  --out <dir>     Output directory (default results)
  -h, --help      Show this help

Fails, writing nothing, if any output would hold an absolute path under a home directory.`;

async function main(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			bench: { type: "string", default: fileURLToPath(new URL("../.bench", import.meta.url)) },
			out: { type: "string", default: fileURLToPath(new URL("../results", import.meta.url)) },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const { files } = await exportResults({ benchDir: values.bench, outDir: values.out, repoRoot: REPO_ROOT, batches: STUDY_BATCHES, calibration: STUDY_CALIBRATION });
	process.stdout.write(`wrote ${files.length} files to ${values.out}; absolute-path scan passed\n`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => { process.exitCode = code; },
		(error) => {
			process.stderr.write(`export-results: ${error.message}\n`);
			process.exitCode = 1;
		},
	);
}
