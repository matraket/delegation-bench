#!/usr/bin/env node
// Batch report over completed benchmark runs: cost per arm, evidence-budget
// adherence and reply language. Read-only over run data.
import { parseArgs } from "node:util";
import { buildReport, writeReport } from "./lib/report/index.mjs";
import { summaryLine } from "./lib/report/markdown.mjs";

const USAGE = `Usage: report.mjs <run-id-prefix|glob>... [options]

Writes <out>/<batch>.json and <out>/<batch>.md per selector and prints the tables.

Options:
  --runs <dir>     Runs root (default .bench/runs)
  --out <dir>      Output directory (default .bench/reports)
  -h, --help       Show this help`;

async function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			runs: { type: "string", default: ".bench/runs" },
			out: { type: "string", default: ".bench/reports" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help || positionals.length === 0) {
		process.stdout.write(`${USAGE}\n`);
		return values.help ? 0 : 1;
	}
	for (const selector of positionals) {
		const report = await buildReport({ runsRoot: values.runs, selector });
		const written = await writeReport(report, values.out);
		process.stdout.write(`${summaryLine(report)}\n${written.text.split("\n").slice(3).join("\n")}wrote ${written.json} and ${written.markdown}\n\n`);
	}
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error) => {
		process.stderr.write(`report: ${error.message}\n`);
		process.exitCode = 1;
	},
);
