import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARM_NAMES, armDefinition } from "./arms.mjs";
import { CONTEXT_FIXTURES, DEFAULT_KEEP_PACKAGES } from "./home.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Machine-specific inputs have no default: each comes from a flag, the run
// spec, or its environment variable (in that order).
//   source       Gentle Shell package directory to copy into every arm.
//   donor        Gentle Shell package directory from before gentle-shell#1590
//                (commit 289cee5b), needed only by the old-rules arm.
//   templateHome Agent home with the provider package installed under npm/.
export const PATH_ENV = Object.freeze({
	source: "DELEGATION_BENCH_SOURCE",
	donor: "DELEGATION_BENCH_DONOR",
	templateHome: "DELEGATION_BENCH_TEMPLATE_HOME",
});

const PATH_FLAGS = { source: "--source", donor: "--donor", templateHome: "--template-home" };
const PATH_HINTS = {
	source: "the Gentle Shell package directory to benchmark (it holds bin/gentle-shell.mjs and assets/)",
	donor: "the Gentle Shell package directory at commit 289cee5b, before gentle-shell#1590",
	templateHome: "an agent home with the provider package installed under npm/ (for example ~/.gentle-shell/agent)",
};

export const DEFAULTS = Object.freeze({
	workDir: join(REPO_ROOT, ".bench"),
	arms: ARM_NAMES,
	models: ["nan/glm5.3-flash"],
	repetitions: 1,
	contextFixture: "none",
	background: false,
	thinking: "high",
	turnDeadlineSec: 900,
	keepPackages: DEFAULT_KEEP_PACKAGES,
});

// Inherited variables that would change which pi runs, which home it uses,
// or disable subagents (for example when the runner itself runs inside a
// Gentle Shell child). They are removed from the launch environment.
const UNSET_PREFIXES = ["GENTLE_PI_AGENTS"];
const UNSET_NAMES = ["PI_CODING_AGENT_DIR", "GENTLE_PI_AGENT_HOME", "GENTLE_SHELL_PI"];

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Question file: {id, cwd?, turns: [{id, prompt, deadlineSec?}]}; cwd is relative to the file. */
export async function loadQuestions(path, cwdOverride) {
	const file = resolve(path);
	let data;
	try {
		data = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		throw new Error(`cannot read question file ${file}: ${error.message}`);
	}
	if (!Array.isArray(data?.turns) || data.turns.length === 0) throw new Error(`${file}: "turns" must be a non-empty array`);
	const seen = new Set();
	const turns = data.turns.map((turn, index) => {
		if (typeof turn?.id !== "string" || turn.id.length === 0) throw new Error(`${file}: turn ${index + 1} needs a string "id"`);
		if (seen.has(turn.id)) throw new Error(`${file}: duplicate turn id "${turn.id}"`);
		seen.add(turn.id);
		if (typeof turn.prompt !== "string" || turn.prompt.trim().length === 0) throw new Error(`${file}: turn "${turn.id}" needs a non-empty "prompt"`);
		if (turn.deadlineSec !== undefined && !(Number.isFinite(turn.deadlineSec) && turn.deadlineSec > 0)) throw new Error(`${file}: turn "${turn.id}" deadlineSec must be a positive number`);
		return { id: turn.id, prompt: turn.prompt, ...(turn.deadlineSec ? { deadlineMs: Math.round(turn.deadlineSec * 1000) } : {}) };
	});
	const cwd = cwdOverride ? resolve(cwdOverride) : resolve(dirname(file), data.cwd ?? ".");
	if (!(await isDirectory(cwd))) throw new Error(`session working directory does not exist: ${cwd}`);
	return { path: file, id: typeof data.id === "string" ? data.id : null, cwd, turns };
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer, got: ${value}`);
	return number;
}

function list(value) {
	return Array.isArray(value) ? value : String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBackground(value) {
	if (typeof value === "boolean") return value;
	if (value === "on") return true;
	if (value === "off") return false;
	throw new Error(`--background must be on or off, got: ${value}`);
}

const present = (value) => typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;

/** A path from the merged spec, else its environment variable; null when neither is set. */
function pathInput(merged, key, env) {
	if (present(merged[key])) return resolve(merged[key]);
	return present(env[PATH_ENV[key]]) ? resolve(env[PATH_ENV[key]]) : null;
}

function missingPath(key, reason = "") {
	return new Error(`${reason}${PATH_FLAGS[key]} <dir> is required (or set ${PATH_ENV[key]}): ${PATH_HINTS[key]}`);
}

/**
 * Merge defaults, a run-spec file (optional) and CLI overrides; validate.
 * Machine-specific paths fall back to their environment variables (PATH_ENV).
 */
export function resolveSpec(fileSpec = {}, overrides = {}, env = process.env) {
	const merged = { ...DEFAULTS, ...fileSpec };
	for (const [key, value] of Object.entries(overrides)) if (value !== undefined) merged[key] = value;
	const arms = list(merged.arms).flatMap((name) => (name === "all" ? ARM_NAMES : [name]));
	for (const name of arms) armDefinition(name);
	const source = pathInput(merged, "source", env);
	if (!source) throw missingPath("source");
	const templateHome = pathInput(merged, "templateHome", env);
	if (!templateHome) throw missingPath("templateHome");
	const donor = pathInput(merged, "donor", env);
	if (!donor && arms.some((name) => armDefinition(name).rules === "old-rules")) throw missingPath("donor", "the old-rules arm needs the donor package: ");
	const models = list(merged.models);
	if (models.length === 0) throw new Error("at least one model is required");
	if (!CONTEXT_FIXTURES.includes(merged.contextFixture)) throw new Error(`--context must be one of ${CONTEXT_FIXTURES.join(", ")}, got: ${merged.contextFixture}`);
	const turnDeadlineSec = Number(merged.turnDeadlineSec);
	if (!(Number.isFinite(turnDeadlineSec) && turnDeadlineSec > 0)) throw new Error(`--turn-deadline must be a positive number of seconds, got: ${merged.turnDeadlineSec}`);
	if (!merged.questions) throw new Error("a question file is required (--questions or \"questions\" in the run spec)");
	return {
		...merged,
		arms: [...new Set(arms)],
		models,
		repetitions: positiveInteger(merged.repetitions, "--repetitions"),
		background: parseBackground(merged.background),
		turnDeadlineSec,
		source,
		donor,
		templateHome,
		workDir: resolve(merged.workDir),
		launcher: resolve(merged.launcher ?? join(source, "bin", "gentle-shell.mjs")),
		questions: resolve(merged.questions),
		keepPackages: list(merged.keepPackages),
		runId: merged.runId ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
	};
}

export function modelSlug(model) {
	return model.replace(/[/:\\]/g, "_");
}

/** Every arm x model x repetition, in a stable order. */
export function planRuns(spec) {
	const runs = [];
	for (const arm of spec.arms) {
		for (const model of spec.models) {
			for (let rep = 1; rep <= spec.repetitions; rep += 1) {
				const runDir = join(spec.workDir, "runs", spec.runId, arm, modelSlug(model), `rep-${rep}`);
				runs.push({ arm, model, rep, runDir, home: join(runDir, "home") });
			}
		}
	}
	return runs;
}

/** Launcher argv: gentle-shell options, then `--`, then pi options. */
export function launchCommand({ launcher, home, packageRoot, model, thinking, sessionDir, excludeTools = [] }) {
	const pi = ["--mode", "rpc", "--model", model, ...(thinking ? ["--thinking", thinking] : []), "--session-dir", sessionDir];
	if (excludeTools.length > 0) pi.push("--exclude-tools", excludeTools.join(","));
	return { command: process.execPath, args: [launcher, "--home", home, "--package-root", packageRoot, "--", ...pi] };
}

/**
 * Launch environment: the caller's environment (children inherit it, which is
 * how NAN_API_KEY reaches them) minus variables that would redirect pi, plus
 * the isolation overrides. Returns the env and a manifest-safe description.
 */
export function launchEnv({ baseEnv, home, runDir, background }) {
	const env = { ...baseEnv };
	const unset = Object.keys(env).filter((name) => UNSET_NAMES.includes(name) || UNSET_PREFIXES.some((prefix) => name.startsWith(prefix)));
	for (const name of unset) delete env[name];
	const overrides = {
		GENTLE_SHELL_HOME: home,
		GENTLE_SHELL_CONFIG: join(runDir, "gentle-shell-config.json"),
		GENTLE_PI_CONFIG_HOME: join(runDir, "gentle-pi-config"),
		GENTLE_SHELL_NO_AUTO_SETUP: "1",
		DO_NOT_TRACK: "1",
		GENTLE_PI_BACKGROUND_SUBAGENTS: background ? "on" : "off",
	};
	Object.assign(env, overrides);
	return { env, overrides, unset: unset.sort() };
}

/** Manifest view of the environment: overrides only, and never a key value. */
export function describeEnv(overrides, baseEnv) {
	return { ...overrides, NAN_API_KEY: baseEnv.NAN_API_KEY ? "<set>" : "<missing>" };
}

function quote(value) {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatCommand({ command, args }, overrides) {
	const env = Object.entries(overrides).map(([name, value]) => `${name}=${quote(value)}`);
	return [...env, "NAN_API_KEY=<from environment>", quote(command), ...args.map(quote)].join(" ");
}
