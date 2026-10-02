#!/usr/bin/env node
// Blind key-fact grader for benchmark answers. Each user turn's final parent
// answer is judged against its key in the question set; the judge never sees
// the arm, model, run id or costs. Read-only over run data.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCache } from "./lib/grade/cache.mjs";
import { DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_URL, createNanJudge, requireApiKey } from "./lib/grade/judge.mjs";
import { buildKeyIndex, loadQuestionSet } from "./lib/grade/keys.mjs";
import { PROMPT_VERSION } from "./lib/grade/prompt.mjs";
import { DEFAULT_ABORT_AFTER, collectAnswers, forecast, gradeAnswers, summarize } from "./lib/grade/run.mjs";
import { computeAgreement, sampleBlind } from "./lib/grade/sample.mjs";

const DEFAULT_SET = fileURLToPath(new URL("./questions/gentle-shell-cc36bd8d.set.json", import.meta.url));

const USAGE = `Usage:
  grade.mjs [<run-id-prefix|glob>...] [options]          grade answers (all runs when no selector)
  grade.mjs [<selector>...] --dry-run                    counts and judge token forecast, no API call
  grade.mjs [<selector>...] --sample N --seed S --export <file>   blind calibration sample, no API call
  grade.mjs --agreement <judge-results> <reference-results>      judge vs reference agreement

Options:
  --runs <dir>          Runs root (default .bench/runs)
  --set <file>          Question set with answer keys (default questions/gentle-shell-cc36bd8d.set.json)
  --out <dir>           Output directory: grades.jsonl, summary.json, summary.md, cache/ (default .bench/grading)
  --judge <model>       Judge model (default ${DEFAULT_JUDGE_MODEL})
  --judge-url <url>     Chat completions endpoint (default ${DEFAULT_JUDGE_URL})
  --no-json-mode        Do not send response_format json_object
  --concurrency <n>     Judge calls in flight (default 2)
  --timeout-ms <ms>     Per-request timeout (default 120000)
  --max-retries <n>     Retries on 429, 5xx, network errors, timeouts and broken bodies (default 4)
  --abort-after <n>     Stop the batch after n consecutive answers fail every retry (default ${DEFAULT_ABORT_AFTER})
  -h, --help            Show this help

The API key is read only from NAN_API_KEY.`;

const int = (value, name, min = 0) => {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
	return n;
};

/** A JSON document (array, or object with `entries`) or JSONL records; a one-line JSONL file is one record. */
async function readResults(path) {
	const text = await readFile(path, "utf8");
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	}
	return Array.isArray(data) || Array.isArray(data?.entries) ? data : [data];
}

function skippedRunLines({ skippedRuns, misaligned }) {
	return [
		`skipped runs: ${skippedRuns.length + misaligned.length} (${skippedRuns.length} not completed, ${misaligned.length} misaligned)`,
		...skippedRuns.map((r) => `  ${r.runId}: status ${r.status}`),
		...misaligned.map((r) => `  ${r.runId}: turn ${r.turnIndex} (${r.turnId}) prompt does not match the key`),
	];
}

function forecastLines(result) {
	const width = Math.max(5, ...result.batches.map((b) => b.batch.length));
	const line = (b, label) => `${label.padEnd(width)}  ${b.runs} runs  ${b.turns} turns  ${b.answers} answers  ${b.emptyAnswers} empty  ${b.cached} cached  ${b.duplicates} duplicate  to judge ${b.toJudge}  est. judge prompt tokens ${b.estPromptTokens}  est. output tokens ${b.estOutputTokens}`;
	return [...result.batches.map((b) => line(b, b.batch)), line(result.total, "TOTAL")];
}

function summaryMarkdown(summary) {
	const pct = (v) => (v === null ? "-" : `${Math.round(v * 100)}%`);
	const num = (v) => (v === null ? "-" : v.toFixed(2));
	const rows = summary.groups.map((g) => `| ${g.batch} | ${g.model} | ${g.arm} | ${g.answers} | ${g.graded} | ${g.errors} | ${g.emptyAnswers} | ${num(g.medianScore)} | ${num(g.meanScore)} | ${pct(g.fullyCorrectShare)} | ${g.forbiddenClaims} | ${g.language.en}/${g.language.es}/${g.language.other} |`);
	return [
		`# Grades (${summary.judgeModel}, ${summary.promptVersion})`,
		"",
		"| Batch | Model | Arm | Answers | Graded | Errors | Empty | Median score | Mean score | Fully correct | Forbidden claims | Language en/es/other |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"Score: supported key facts / total key facts per answer (empty answers score 0). Graded: answers with a judge verdict (empty answers are counted under Empty, not Graded). Fully correct: every fact supported and no forbidden claim.",
		...(summary.skippedRuns.length || summary.misaligned.length ? ["", ...skippedRunLines(summary)] : []),
		"",
	].join("\n");
}

async function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		allowNegative: true,
		options: {
			runs: { type: "string", default: ".bench/runs" },
			set: { type: "string", default: DEFAULT_SET },
			out: { type: "string", default: ".bench/grading" },
			judge: { type: "string", default: DEFAULT_JUDGE_MODEL },
			"judge-url": { type: "string", default: DEFAULT_JUDGE_URL },
			"json-mode": { type: "boolean", default: true },
			concurrency: { type: "string", default: "2" },
			"timeout-ms": { type: "string", default: "120000" },
			"max-retries": { type: "string", default: "4" },
		"abort-after": { type: "string", default: String(DEFAULT_ABORT_AFTER) },
			"dry-run": { type: "boolean", default: false },
			sample: { type: "string" },
			seed: { type: "string", default: "5139" },
			export: { type: "string" },
			agreement: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (values.agreement) {
		if (positionals.length !== 2) throw new Error("--agreement needs <judge-results> <reference-results>");
		const result = computeAgreement(await readResults(positionals[0]), await readResults(positionals[1]));
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	}

	const selectors = positionals.length ? positionals : ["*"];
	const keyIndex = buildKeyIndex(await loadQuestionSet(values.set));
	const collected = await collectAnswers({ runsRoot: values.runs, selectors, keyIndex });
	const { answers, unmapped, misaligned, skippedRuns } = collected;
	if (misaligned.length || skippedRuns.length) process.stderr.write(`grade: ${skippedRunLines(collected).join("\n")}\n`);
	if (answers.length === 0) throw new Error(`no gradable answers for ${selectors.join(" ")} under ${values.runs}`);
	if (unmapped.length) process.stderr.write(`grade: ${unmapped.length} turns have no key in the question set and are not graded\n`);

	if (values.sample !== undefined) {
		if (!values.export) throw new Error("--sample needs --export <file>");
		const sample = sampleBlind(answers, int(values.sample, "--sample", 1), int(values.seed, "--seed"));
		await mkdir(dirname(values.export), { recursive: true });
		await writeFile(values.export, `${JSON.stringify(sample, null, 2)}\n`);
		process.stdout.write(`exported ${sample.entries.length} blind answers to ${values.export} (seed ${sample.seed}); no judge call\n`);
		return 0;
	}

	const cache = createCache(join(values.out, "cache"));
	const plan = await forecast(answers, { judgeModel: values.judge, cache });
	if (values["dry-run"]) {
		process.stdout.write(`judge ${values.judge}, prompt ${PROMPT_VERSION}\n${forecastLines(plan).join("\n")}\n${skippedRunLines(collected).join("\n")}\n`);
		process.stdout.write("Token estimates: prompt = chars/4 of the judge messages; output = visible JSON only, reasoning tokens not included.\n");
		process.stdout.write("dry run: no judge call was made\n");
		return 0;
	}

	const apiKey = plan.total.toJudge > 0 ? requireApiKey(process.env) : null;
	const judge = createNanJudge({
		model: values.judge,
		apiKey,
		url: values["judge-url"],
		jsonMode: values["json-mode"],
		timeoutMs: int(values["timeout-ms"], "--timeout-ms", 1),
		maxRetries: int(values["max-retries"], "--max-retries"),
	});
	const records = await gradeAnswers(answers, {
		judge,
		judgeModel: values.judge,
		cache,
		concurrency: int(values.concurrency, "--concurrency", 1),
		abortAfter: int(values["abort-after"], "--abort-after", 1),
		onProgress: (done, total) => {
			if (done % 25 === 0 || done === total) process.stderr.write(`grade: ${done}/${total}\n`);
		},
	});
	const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
	for (const r of records) for (const k of Object.keys(usage)) usage[k] += r.usage[k];
	const summary = { judgeModel: values.judge, promptVersion: PROMPT_VERSION, selectors, answers: records.length, usage, unmapped, skippedRuns, misaligned, groups: summarize(records) };
	await mkdir(values.out, { recursive: true });
	await writeFile(join(values.out, "grades.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	await writeFile(join(values.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	await writeFile(join(values.out, "summary.md"), summaryMarkdown(summary));
	const count = (source) => records.filter((r) => r.judge.source === source && !r.error).length;
	const errors = records.filter((r) => r.error).length;
	process.stdout.write(`${records.length} answers: ${count("judge")} judged, ${count("cache")} cached, ${count("dedupe")} deduplicated, ${count("skipped")} empty, ${errors} errors; judge usage this run ${usage.calls} calls, prompt ${usage.promptTokens}, completion ${usage.completionTokens}\n`);
	if (misaligned.length || skippedRuns.length) process.stdout.write(`${skippedRunLines(collected).join("\n")}\n`);
	process.stdout.write(summaryMarkdown(summary));
	process.stdout.write(`wrote ${join(values.out, "grades.jsonl")}, summary.json and summary.md\n`);
	return errors || misaligned.length ? 2 : 0;
}

main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error) => {
		process.stderr.write(`grade: ${error.message}\n`);
		process.exitCode = 1;
	},
);
