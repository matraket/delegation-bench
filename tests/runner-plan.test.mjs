import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULTS, PATH_ENV, resolveSpec } from "../lib/runner/plan.mjs";
import { TEST_LINE_MAP_PATH, makeSource, makeTemplateHome } from "./runner-helpers.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../run-bench.mjs", import.meta.url));
const QUESTIONS = fileURLToPath(new URL("./fixtures/questions.example.json", import.meta.url));

const base = { questions: QUESTIONS };
const paths = { source: "/opt/release", donor: "/opt/donor", templateHome: "/opt/template" };

test("the defaults hold no machine-specific path for the release, the donor or the template home", () => {
	assert.equal(DEFAULTS.source, undefined);
	assert.equal(DEFAULTS.donor, undefined);
	assert.equal(DEFAULTS.templateHome, undefined);
	assert.deepEqual(PATH_ENV, { source: "DELEGATION_BENCH_SOURCE", donor: "DELEGATION_BENCH_DONOR", templateHome: "DELEGATION_BENCH_TEMPLATE_HOME" });
});

test("a missing release names its flag and its environment variable", () => {
	assert.throws(() => resolveSpec({}, { ...base, templateHome: paths.templateHome, arms: "shipped" }, {}), /--source .*DELEGATION_BENCH_SOURCE/);
});

test("a missing template home names its flag and its environment variable", () => {
	assert.throws(() => resolveSpec({}, { ...base, source: paths.source, arms: "shipped" }, {}), /--template-home .*DELEGATION_BENCH_TEMPLATE_HOME/);
});

test("the donor is required only when old-rules is selected", () => {
	const spec = resolveSpec({}, { ...base, source: paths.source, templateHome: paths.templateHome, arms: "shipped,delegate" }, {});
	assert.equal(spec.donor, null);
	assert.throws(() => resolveSpec({}, { ...base, source: paths.source, templateHome: paths.templateHome, arms: "shipped,old-rules" }, {}), /old-rules .*--donor .*DELEGATION_BENCH_DONOR/);
	assert.throws(() => resolveSpec({}, { ...base, source: paths.source, templateHome: paths.templateHome, arms: "all" }, {}), /DELEGATION_BENCH_DONOR/);
});

test("environment variables fill paths that no flag or run spec gives; empty values count as unset", () => {
	const env = { DELEGATION_BENCH_SOURCE: "/env/release", DELEGATION_BENCH_DONOR: "/env/donor", DELEGATION_BENCH_TEMPLATE_HOME: "/env/template" };
	const spec = resolveSpec({}, { ...base, arms: "all" }, env);
	assert.equal(spec.source, resolve("/env/release"));
	assert.equal(spec.donor, resolve("/env/donor"));
	assert.equal(spec.templateHome, resolve("/env/template"));
	assert.equal(spec.launcher, join(resolve("/env/release"), "bin", "gentle-shell.mjs"));
	assert.throws(() => resolveSpec({}, { ...base, arms: "shipped", templateHome: paths.templateHome }, { DELEGATION_BENCH_SOURCE: "" }), /DELEGATION_BENCH_SOURCE/);
});

test("a flag beats the run spec, and the run spec beats the environment", () => {
	const env = { DELEGATION_BENCH_SOURCE: "/env/release", DELEGATION_BENCH_TEMPLATE_HOME: "/env/template" };
	const fromFlag = resolveSpec({ source: "/spec/release" }, { ...base, arms: "shipped", source: "/flag/release" }, env);
	assert.equal(fromFlag.source, resolve("/flag/release"));
	const fromSpec = resolveSpec({ source: "/spec/release" }, { ...base, arms: "shipped" }, env);
	assert.equal(fromSpec.source, resolve("/spec/release"));
	assert.equal(fromSpec.templateHome, resolve("/env/template"));
});

test("run-bench without a release path exits 1 with the flag and the variable in the message, before building anything", async () => {
	const env = { ...process.env };
	for (const name of Object.values(PATH_ENV)) delete env[name];
	delete env.NAN_API_KEY;
	await assert.rejects(run(process.execPath, [CLI, "--dry-run", "--arms", "shipped", "--questions", QUESTIONS, "--template-home", "/nonexistent-template"], { env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /--source .*DELEGATION_BENCH_SOURCE/);
		return true;
	});
});

test("run-bench takes every path from the environment when no flag is given", async () => {
	const { source, donor, root } = await makeSource();
	const template = await makeTemplateHome();
	const env = { ...process.env, DELEGATION_BENCH_SOURCE: source, DELEGATION_BENCH_DONOR: donor, DELEGATION_BENCH_TEMPLATE_HOME: template };
	delete env.NAN_API_KEY;
	const { stdout } = await run(process.execPath, [CLI, "--dry-run", "--arms", "old-rules,shipped", "--questions", QUESTIONS, "--work-dir", join(root, "work"), "--run-id", "env", "--old-rules-map", TEST_LINE_MAP_PATH], { env });
	assert.match(stdout, /2 runs planned/);
	assert.match(stdout, /dry run: no model session was started/);
});
