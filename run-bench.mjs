#!/usr/bin/env node
// Delegation benchmark runner: builds per-arm Gentle Shell package copies and
// isolated agent homes, drives one multi-turn RPC session per arm x model x
// repetition, and runs the session cost analyzer over each parent session.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ARM_NAMES } from "./lib/runner/arms.mjs";
import { DEFAULTS, resolveSpec } from "./lib/runner/plan.mjs";
import { runBench } from "./lib/runner/run.mjs";

const USAGE = `Usage: run-bench.mjs --questions <file.json> [options]

Options:
  --spec <file.json>        Run spec (same keys as the options, camelCase); flags override it
  --questions <file.json>   Question file: {id, cwd?, turns: [{id, prompt, deadlineSec?}]}
  --arms <a,b|all>          Arms (default all): ${ARM_NAMES.join(", ")}
  --models <m1,m2>          Models as <provider>/<model> (default ${DEFAULTS.models.join(",")})
  --repetitions <n>         Repetitions per arm and model (default ${DEFAULTS.repetitions})
  --context <fixture>       none | managed-blocks (default ${DEFAULTS.contextFixture})
  --background <on|off>     Background subagents (default off)
  --thinking <level>        Thinking level for the parent and every agent (default ${DEFAULTS.thinking})
  --turn-deadline <sec>     Per-turn deadline in seconds (default ${DEFAULTS.turnDeadlineSec})
  --cwd <dir>               Session working directory (default: the question file's cwd)
  --source <dir>            Gentle Shell release to copy (default ${DEFAULTS.source})
  --donor <dir>             Pre-#1590 release for old-rules (default ${DEFAULTS.donor})
  --old-rules-map <file>    Line map for old-rules (default arms/old-rules.json)
  --template-home <dir>     Agent home template (default ${DEFAULTS.templateHome})
  --work-dir <dir>          Work directory for arms and runs (default ${DEFAULTS.workDir})
  --launcher <file>         Launcher script (default <source>/bin/gentle-shell.mjs)
  --run-id <id>             Run id (default: UTC timestamp)
  --dry-run                 Build arms and homes and print the plan; start no model session
  -h, --help                Show this help

A live run needs NAN_API_KEY in the environment; it is never read from auth.json.`;

const SPEC_KEYS = {
	arms: "arms",
	models: "models",
	repetitions: "repetitions",
	context: "contextFixture",
	background: "background",
	thinking: "thinking",
	"turn-deadline": "turnDeadlineSec",
	cwd: "cwd",
	source: "source",
	donor: "donor",
	"old-rules-map": "oldRulesMap",
	"template-home": "templateHome",
	"work-dir": "workDir",
	launcher: "launcher",
	"run-id": "runId",
	questions: "questions",
};

async function main(argv) {
	const options = Object.fromEntries(Object.keys(SPEC_KEYS).map((name) => [name, { type: "string" }]));
	const { values } = parseArgs({
		args: argv,
		options: { ...options, spec: { type: "string" }, "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
	});
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const fileSpec = values.spec ? JSON.parse(await readFile(values.spec, "utf8")) : {};
	const overrides = Object.fromEntries(Object.entries(SPEC_KEYS).map(([flag, key]) => [key, values[flag]]));
	const spec = resolveSpec(fileSpec, overrides);
	const { manifests } = await runBench(spec, { dryRun: values["dry-run"] });
	return manifests.every((manifest) => manifest.status === "completed") ? 0 : 2;
}

// Leave through process.exit on SIGINT/SIGTERM so exit hooks run: the RPC
// client uses one to stop the launcher's detached process group, which no
// longer receives terminal signals itself.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => process.exit(code));

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		process.stderr.write(`run-bench: ${error.message}\n`);
		process.exitCode = 1;
	},
);
