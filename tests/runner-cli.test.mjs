import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeSource, makeTemplateHome } from "./runner-helpers.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../run-bench.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const QUESTIONS = fileURLToPath(new URL("./fixtures/questions.example.json", import.meta.url));
const KEY = "dummy-key-value-123";

async function setup() {
	const { source, donor, root } = await makeSource();
	const template = await makeTemplateHome();
	const workDir = join(root, "work");
	const marker = join(root, "spawned.json");
	const args = ["--questions", QUESTIONS, "--source", source, "--donor", donor, "--template-home", template, "--work-dir", workDir, "--launcher", FAKE_PI, "--run-id", "test", "--old-rules-map", fileURLToPath(new URL("./fixtures/old-rules.test.json", import.meta.url))];
	const env = { ...process.env, FAKE_PI_MARKER: marker };
	delete env.NAN_API_KEY;
	return { workDir, marker, args, env };
}

test("--dry-run builds every arm and home, prints the commands, and spawns nothing", async () => {
	const { workDir, marker, args, env } = await setup();
	const { stdout } = await run(process.execPath, [CLI, ...args, "--dry-run", "--arms", "all", "--repetitions", "2", "--context", "managed-blocks"], { env });
	for (const arm of ["old-rules", "inline", "shipped", "shipped-nonlean", "delegate", "delegate-nonlean"]) {
		assert.ok(existsSync(join(workDir, "arms", arm, "assets", "orchestrator.md")), arm);
		for (const rep of [1, 2]) assert.ok(existsSync(join(workDir, "runs", "test", arm, "nan_glm5.3-flash", `rep-${rep}`, "home", "AGENTS.md")), `${arm} rep ${rep}`);
		assert.match(stdout, new RegExp(`--package-root \\S*${arm}\\b`));
	}
	assert.match(stdout, /--exclude-tools subagent_list_agents,subagent_run,/);
	assert.match(stdout, /GENTLE_PI_BACKGROUND_SUBAGENTS=off/);
	assert.match(stdout, /-- --mode rpc --model nan\/glm5\.3-flash --thinking high --session-dir /);
	assert.match(stdout, /12 runs planned/);
	assert.match(stdout, /dry run: no model session was started/);
	assert.ok(!existsSync(marker), "dry run must not spawn the launcher");
});

test("a live run without NAN_API_KEY is refused before anything is built or spawned", async () => {
	const { workDir, marker, args, env } = await setup();
	await assert.rejects(run(process.execPath, [CLI, ...args, "--arms", "shipped"], { env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /NAN_API_KEY is not set/);
		return true;
	});
	assert.ok(!existsSync(marker));
	assert.ok(!existsSync(join(workDir, "runs")));
});

test("a live run drives the session, writes the manifest and the analyzer report, and never records the key", async () => {
	const { workDir, marker, args, env } = await setup();
	const { stdout } = await run(process.execPath, [CLI, ...args, "--arms", "shipped", "--turn-deadline", "20"], { env: { ...env, NAN_API_KEY: KEY } });
	const runDir = join(workDir, "runs", "test", "shipped", "nan_glm5.3-flash", "rep-1");
	assert.match(stdout, /shipped .*completed/);
	const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
	assert.equal(manifest.status, "completed");
	assert.equal(manifest.arm, "shipped");
	assert.equal(manifest.model, "nan/glm5.3-flash");
	assert.equal(manifest.rep, 1);
	assert.equal(manifest.home, join(runDir, "home"));
	assert.equal(manifest.packageRoot, join(workDir, "arms", "shipped"));
	assert.match(manifest.sessionFile, /fake-session-0001\.jsonl$/);
	assert.deepEqual(manifest.turns.map((turn) => [turn.id, turn.status]), [["q1", "settled"], ["q1-followup", "settled"]]);
	assert.equal(manifest.env.NAN_API_KEY, "<set>");
	assert.equal(manifest.env.GENTLE_PI_BACKGROUND_SUBAGENTS, "off");
	assert.deepEqual(manifest.uiRequests, []);
	const analysis = JSON.parse(await readFile(join(runDir, "analysis.json"), "utf8"));
	assert.equal(analysis.schemaVersion, 1);
	assert.equal(analysis.parents[0].session.turns, 2);
	assert.deepEqual(analysis.parents[0].session.tokens, { input: 200, cacheRead: 100, cacheWrite: 0, output: 20 });
	// The launcher got the key through the environment only.
	assert.equal(JSON.parse(await readFile(marker, "utf8")).keySet, true);
	for (const name of await readdir(runDir)) {
		if (name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".log")) assert.ok(!(await readFile(join(runDir, name), "utf8")).includes(KEY), name);
	}
});

test("unknown arms and invalid options are rejected", async () => {
	const { args, env } = await setup();
	await assert.rejects(run(process.execPath, [CLI, ...args, "--dry-run", "--arms", "shipped,bogus"], { env }), /unknown arm: bogus/);
	await assert.rejects(run(process.execPath, [CLI, ...args, "--dry-run", "--background", "maybe"], { env }), /--background must be on or off/);
});
