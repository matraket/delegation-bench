import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultAgentHomes, resolveSessionArg } from "../lib/resolve.mjs";
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

test("fails clearly for an unknown id or a missing path", async () => {
	await assert.rejects(resolveSessionArg("nope-0000", AGENT_HOMES), /session not found: nope-0000/);
	await assert.rejects(resolveSessionArg(join(FIXTURES, "missing.jsonl"), AGENT_HOMES), /session not found/);
});
