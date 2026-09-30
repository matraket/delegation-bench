import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession, summarizeSession } from "../lib/session-metrics.mjs";
import { selectProfiles } from "../lib/weights.mjs";
import { PARENT_PATH } from "./helpers.mjs";

const profiles = selectProfiles();

test("reads the header and skips malformed lines, counting them", async () => {
	const session = await readSession(PARENT_PATH);
	assert.equal(session.id, "parent-0001");
	assert.equal(session.cwd, "/tmp/proj");
	assert.equal(session.malformedLines, 1);
});

test("sums raw tokens over billed assistant turns only", async () => {
	const metrics = summarizeSession(await readSession(PARENT_PATH), profiles);
	assert.equal(metrics.turns, 4);
	assert.deepEqual(metrics.tokens, { input: 190, cacheRead: 530, cacheWrite: 60, output: 25 });
	assert.equal(metrics.promptTokens, 780);
});

test("counts zero-usage and missing-usage turns separately with their stop reasons", async () => {
	const metrics = summarizeSession(await readSession(PARENT_PATH), profiles);
	assert.equal(metrics.zeroUsageTurns, 2);
	assert.deepEqual(metrics.zeroUsageStopReasons, { aborted: 1, error: 1 });
});

test("reports first-turn prefix, peak prompt and final context", async () => {
	const metrics = summarizeSession(await readSession(PARENT_PATH), profiles);
	assert.equal(metrics.firstPrefix, 150);
	assert.equal(metrics.peakPrompt, 240);
	assert.equal(metrics.finalContext, 220);
});

test("lists models with their billed turn counts and weighs every profile", async () => {
	const metrics = summarizeSession(await readSession(PARENT_PATH), profiles);
	assert.deepEqual(metrics.models, [
		{ model: "nan/m1", turns: 3 },
		{ model: "p2/m2", turns: 1 },
	]);
	assert.deepEqual(metrics.cost, { api: 443, nan: 745 });
});
