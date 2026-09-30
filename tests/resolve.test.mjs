import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultAgentHomes, findSessionFilesById, resolveSessionArg } from "../lib/resolve.mjs";
import { AGENT_HOMES, CHILD1_PATH, FIXTURES, PARENT_PATH, SOLO_PATH } from "./helpers.mjs";

test("default agent homes are the gentle-shell and pi homes under the given home", () => {
	assert.deepEqual(defaultAgentHomes("/h"), [join("/h", ".gentle-shell", "agent"), join("/h", ".pi", "agent")]);
});

test("resolves a session id by searching the sessions of every agent home", async () => {
	assert.equal(await resolveSessionArg("parent-0001", AGENT_HOMES), PARENT_PATH);
	assert.equal(await resolveSessionArg("solo-0002", AGENT_HOMES), SOLO_PATH);
});

test("resolves a child session id stored under gentle-agents/sessions", async () => {
	assert.equal(await resolveSessionArg("child-0001", AGENT_HOMES), CHILD1_PATH);
});

test("accepts an existing file path as is", async () => {
	assert.equal(await resolveSessionArg(PARENT_PATH, []), PARENT_PATH);
});

test("reports an id that matches several session files instead of picking one", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "delegation-bench-resolve-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeA = join(root, "home-a");
	const homeB = join(root, "home-b");
	// Created out of name order so the result cannot rely on creation order.
	const files = [
		join(homeA, "sessions", "--zz--", "2026-01-01T00-00-00-000Z_dup-0001.jsonl"),
		join(homeA, "sessions", "--aa--", "2026-01-03T00-00-00-000Z_dup-0001.jsonl"),
		join(homeB, "gentle-agents", "sessions", "2026-01-02T00-00-00-000Z_dup-0001.jsonl"),
		join(homeB, "sessions", "--mm--", "2026-01-04T00-00-00-000Z_one-0001.jsonl"),
	];
	for (const file of files) {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "");
	}
	const expected = [files[1], files[0], files[2]];
	await assert.rejects(resolveSessionArg("dup-0001", [homeA, homeB]), (error) => {
		assert.match(error.message, /session id is ambiguous: dup-0001 matches 3 files/);
		assert.deepEqual(error.message.split("\n").slice(1).map((line) => line.trim()), expected);
		return true;
	});
	assert.deepEqual(await findSessionFilesById("dup-0001", [homeA, homeB]), expected);
	assert.equal(await resolveSessionArg("one-0001", [homeA, homeB]), files[3]);
});

test("a repeated or symlinked agent home does not make one session ambiguous", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "delegation-bench-resolve-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const alias = join(root, "home-alias");
	const file = join(home, "sessions", "--cwd--", "2026-01-01T00-00-00-000Z_same-0001.jsonl");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "");
	await symlink(home, alias);
	assert.deepEqual(await findSessionFilesById("same-0001", [home, home, alias]), [file]);
	assert.equal(await resolveSessionArg("same-0001", [alias, home]), join(alias, "sessions", "--cwd--", "2026-01-01T00-00-00-000Z_same-0001.jsonl"));
});

test("fails clearly for an unknown id or a missing path", async () => {
	await assert.rejects(resolveSessionArg("nope-0000", AGENT_HOMES), /session not found: nope-0000/);
	await assert.rejects(resolveSessionArg(join(FIXTURES, "missing.jsonl"), AGENT_HOMES), /session not found/);
});
