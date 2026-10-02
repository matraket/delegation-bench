// Synthetic benchmark runs for report and grader tests: a runs root laid out
// like `.bench/runs/<run-id>/<arm>/<model-dir>/rep-1/` with manifest.json,
// analysis.json and the parent session JSONL.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const user = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
export const assistant = (text, { tools = 0 } = {}) => ({
	type: "message",
	message: {
		role: "assistant",
		content: [
			...(text === null ? [] : [{ type: "text", text }]),
			...Array.from({ length: tools }, (_, i) => ({ type: "toolCall", id: `call-${i}`, name: "read", arguments: {} })),
		],
	},
});
export const toolResult = (chars) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(chars) }] } });

export async function makeTempDir(prefix = "bench-") {
	return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Write one run. `spec`: runId, arm, model, questions {path, id}, turns
 * [{id, durationMs, status}], entries (session lines), analysis overrides.
 */
export async function writeRun(root, spec) {
	const modelDir = spec.model.replace("/", "_");
	const repDir = join(root, spec.runId, spec.arm, modelDir, "rep-1");
	await mkdir(join(repDir, "home", "sessions"), { recursive: true });
	const sessionFile = join(repDir, "home", "sessions", "session.jsonl");
	const lines = [{ type: "session", id: `${spec.runId}-session` }, ...spec.entries];
	await writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const manifest = {
		schemaVersion: 1,
		runId: spec.runId,
		arm: spec.arm,
		model: spec.model,
		rep: 1,
		questions: spec.questions,
		status: spec.status ?? "completed",
		sessionFile,
		turns: spec.turns.map((turn) => ({ status: "settled", ...turn })),
	};
	if (spec.manifestOverrides) Object.assign(manifest, spec.manifestOverrides);
	await writeFile(join(repDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	const a = spec.analysis;
	const analysis = {
		schemaVersion: 1,
		profiles: {},
		parents: [
			{
				session: { cost: { nan: a.parentNan ?? a.nan, api: a.parentApi ?? a.api }, peakPrompt: a.peak, finalContext: a.final },
				children: Array.from({ length: a.children ?? 0 }, () => ({})),
				unresolvedTasks: [],
				totals: {
					zeroUsageTurns: a.zero ?? 0,
					tokens: { input: a.input, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite ?? 0, output: a.output },
					cost: { nan: a.nan, api: a.api },
				},
			},
		],
	};
	await writeFile(join(repDir, "analysis.json"), JSON.stringify(analysis, null, 2));
	return repDir;
}

/** Question file written next to the runs, like questions/generated/short/<id>.json. */
export async function writeQuestionFile(root, id, size) {
	const path = join(root, "questions", `${id}.json`);
	await mkdir(join(root, "questions"), { recursive: true });
	await writeFile(path, JSON.stringify({ id: `set/short/${id}`, question: id, size, turns: [{ id }, { id: `${id}-followup` }] }));
	return { path, id: `set/short/${id}` };
}

const SPANISH_TEXT = "El archivo que está en la función para los usuarios también cuando se usa con una opción.";
const ENGLISH_TEXT = "The file that holds the function is read when the process starts, and this is the answer.";

/**
 * Short batch `fx-01-` (model nan/test-model): questions q-small and q-large,
 * arms inline and delegate. Numbers are arbitrary but fixed; the parity test
 * freezes the prototype's output on exactly this fixture.
 */
export async function buildShortBatch(root) {
	const small = await writeQuestionFile(root, "q-small", "small");
	const large = await writeQuestionFile(root, "q-large", "large");
	const turns = (id, a, b) => [{ id, durationMs: a }, { id: `${id}-followup`, durationMs: b }];
	const runs = [
		{
			runId: "fx-01-01-q-small-inline", arm: "inline", questions: small, turns: turns("q-small", 30000, 12000),
			entries: [
				user("small question"), assistant(null, { tools: 2 }), toolResult(8000), toolResult(4000), assistant(ENGLISH_TEXT),
				user("small followup"), assistant("Earlier text."), assistant(null, { tools: 1 }), toolResult(400), assistant("Final small followup answer with the file."),
			],
			analysis: { nan: 200000, api: 40000, peak: 30000, final: 31000, input: 50000, cacheRead: 148000, output: 2000 },
		},
		{
			runId: "fx-01-02-q-small-delegate", arm: "delegate", questions: small, turns: turns("q-small", 60000, 30000),
			entries: [
				user("small question"), assistant(null, { tools: 1 }), toolResult(2000), assistant(SPANISH_TEXT),
				user("small followup"), assistant(ENGLISH_TEXT),
			],
			analysis: { nan: 260000, api: 52000, peak: 20000, final: 21000, input: 60000, cacheRead: 197000, output: 3000, children: 2, parentNan: 120000 },
		},
		{
			runId: "fx-01-03-q-large-inline", arm: "inline", questions: large, turns: turns("q-large", 90000, 45000),
			entries: [
				user("large question"),
				...Array.from({ length: 6 }, () => [assistant(null, { tools: 1 }), toolResult(1000)]).flat(),
				assistant(ENGLISH_TEXT),
				user("large followup"), assistant(null, { tools: 1 }), toolResult(44000), assistant("Large followup answer with the file."),
			],
			analysis: { nan: 900000, api: 120000, peak: 60000, final: 61000, input: 100000, cacheRead: 790000, output: 10000, zero: 1 },
		},
		{
			runId: "fx-01-04-q-large-delegate", arm: "delegate", questions: large, turns: turns("q-large", 120000, 70000),
			entries: [
				user("large question"), assistant(null, { tools: 1 }), toolResult(3000), assistant(ENGLISH_TEXT),
				user("large followup"), assistant(""), assistant("   "),
			],
			analysis: { nan: 600000, api: 150000, peak: 35000, final: 36000, input: 90000, cacheRead: 505000, output: 5000, children: 3, parentNan: 250000 },
		},
	];
	for (const run of runs) await writeRun(root, { model: "nan/test-model", ...run });
	return runs;
}

/** Long batch `lg-01-` (model nan/test-model): 14 turns, arms inline and delegate, two repetitions each. */
export async function buildLongBatch(root) {
	const questions = { path: join(root, "questions", "long.json"), id: "set/long" };
	const session = (spanishAt, heavyAt) => Array.from({ length: 14 }, (_, i) => [
		user(`turn ${i}`),
		...(i === heavyAt ? [assistant(null, { tools: 1 }), toolResult(48000)] : [assistant(null, { tools: 1 }), toolResult(800)]),
		assistant(spanishAt.includes(i) ? SPANISH_TEXT : ENGLISH_TEXT),
	]).flat();
	const turns = (ms) => Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, durationMs: ms + i * 1000 }));
	const runs = [
		{ runId: "lg-01-01-inline-r1", arm: "inline", entries: session([], 3), turns: turns(60000), analysis: { nan: 9000000, api: 1500000, peak: 150000, final: 150000, input: 900000, cacheRead: 8050000, output: 50000 } },
		{ runId: "lg-01-02-delegate-r1", arm: "delegate", entries: session([], -1), turns: turns(120000), analysis: { nan: 4000000, api: 1900000, peak: 80000, final: 79000, input: 1000000, cacheRead: 2960000, output: 40000, children: 20, parentNan: 2000000 } },
		{ runId: "lg-01-03-inline-r2", arm: "inline", entries: session([], -1), turns: turns(70000), analysis: { nan: 10000000, api: 1600000, peak: 160000, final: 158000, input: 950000, cacheRead: 8990000, output: 60000 } },
		{ runId: "lg-01-04-delegate-r2", arm: "delegate", entries: session([0, 12, 13], -1), turns: turns(130000), analysis: { nan: 6500000, api: 2000000, peak: 90000, final: 88000, input: 1100000, cacheRead: 5350000, output: 50000, children: 30, parentNan: 3000000 } },
	];
	for (const run of runs) await writeRun(root, { model: "nan/test-model", questions, ...run });
	return runs;
}
