import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CHILD1_PATH, CHILD2_PATH, PARENT_PATH, PI_HOME, SHELL_HOME } from "./helpers.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../analyze-sessions.mjs", import.meta.url));
const HOMES = ["--agent-home", SHELL_HOME, "--agent-home", PI_HOME];

test("--json prints the documented stable shape", async () => {
	const { stdout } = await run(process.execPath, [CLI, "parent-0001", "solo-0002", "--json", ...HOMES]);
	const report = JSON.parse(stdout);
	assert.equal(report.schemaVersion, 1);
	assert.deepEqual(Object.keys(report.profiles), ["api", "nan"]);
	assert.equal(report.parents.length, 2);
	assert.deepEqual(Object.keys(report.parents[0]), ["session", "children", "unresolvedTasks", "totals"]);
	assert.equal(report.parents[1].children.length, 0);
	assert.equal(report.parents[1].totals.cost.nan, 1002);
});

test("--profile and --weights select the reported profiles", async () => {
	const { stdout } = await run(process.execPath, [CLI, "solo-0002", "--json", "--profile", "nan,custom", "--weights", '{"input":0,"cacheRead":0,"cacheWrite":0,"output":1}', ...HOMES]);
	const report = JSON.parse(stdout);
	assert.deepEqual(report.parents[0].totals.cost, { nan: 1002, custom: 2 });
});

test("the default output is a readable table with parent, children and totals", async () => {
	const { stdout } = await run(process.execPath, [CLI, "parent-0001", ...HOMES]);
	assert.match(stdout, /parent-0001/);
	assert.match(stdout, /child-0001 +explore/);
	assert.match(stdout, /TOTAL/);
	assert.match(stdout, /task-z +no-task-record/);
});

test("fails with a non-zero exit and a message for an unknown session", async () => {
	await assert.rejects(run(process.execPath, [CLI, "nope-0000", ...HOMES]), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /session not found: nope-0000/);
		return true;
	});
});

test("fails with a non-zero exit when --weights reuses a built-in profile name", async () => {
	const weights = '{"name":"api","input":1,"cacheRead":1,"cacheWrite":1,"output":1}';
	await assert.rejects(run(process.execPath, [CLI, "solo-0002", "--weights", weights, ...HOMES]), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /--weights name "api" is reserved for the built-in profile/);
		return true;
	});
});

test("fails with a non-zero exit when --profile selects nothing", async () => {
	for (const selection of ["", " , ,"]) {
		await assert.rejects(run(process.execPath, [CLI, "solo-0002", "--profile", selection, ...HOMES]), (error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /--profile selects no weight profiles/);
			return true;
		});
	}
});

test("never modifies the analyzed session files", async () => {
	const files = [PARENT_PATH, CHILD1_PATH, CHILD2_PATH];
	const before = await Promise.all(files.map(async (file) => [await readFile(file, "utf8"), (await stat(file)).mtimeMs]));
	await run(process.execPath, [CLI, "parent-0001", "--json", ...HOMES]);
	const after = await Promise.all(files.map(async (file) => [await readFile(file, "utf8"), (await stat(file)).mtimeMs]));
	assert.deepEqual(after, before);
});
