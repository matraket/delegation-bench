import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeParent } from "../lib/analyze.mjs";
import { selectProfiles } from "../lib/weights.mjs";
import { AGENT_HOMES, CHILD1_PATH, CHILD2_PATH } from "./helpers.mjs";

const analyze = () => analyzeParent("parent-0001", { agentHomes: AGENT_HOMES, profiles: selectProfiles() });

test("discovers each child session once, linked through task records", async () => {
	const report = await analyze();
	assert.deepEqual(report.children.map((child) => child.id), ["child-0001", "child-0002"]);
	assert.deepEqual(report.children.map((child) => child.path), [CHILD1_PATH, CHILD2_PATH]);
	assert.deepEqual(report.children[0].tasks.map((task) => task.taskId), ["task-a", "task-c"]);
	assert.equal(report.children[0].linkage.method, "task-record");
	assert.equal(report.children[0].linkage.pathResolvedBy, "basename");
});

test("reports per-child agent, start prefix, peak, raw and weighted cost", async () => {
	const [explore, verify] = (await analyze()).children;
	assert.equal(explore.agent, "explore");
	assert.equal(explore.turns, 3);
	assert.equal(explore.startPrefix, 500);
	assert.equal(explore.peakPrompt, 560);
	assert.deepEqual(explore.tokens, { input: 560, cacheRead: 1010, cacheWrite: 0, output: 65 });
	assert.deepEqual(explore.cost, { api: 986, nan: 1635 });
	assert.equal(verify.agent, "verify");
	assert.equal(verify.startPrefix, 400);
	assert.deepEqual(verify.cost, { api: 970, nan: 805 });
});

test("measures the handoff the parent received from tool results and pushed results", async () => {
	const [explore, verify] = (await analyze()).children;
	assert.deepEqual(explore.tasks.map((task) => task.handoff), [
		{ source: "tool-result", chars: 40, tokens: 10, tokensMethod: "estimate:ceil(chars/4)", deliveries: 1 },
		{ source: "tool-result", chars: 12, tokens: 3, tokensMethod: "estimate:ceil(chars/4)", deliveries: 1 },
	]);
	assert.equal(explore.handoffTokens, 13);
	// A subagent_status line mentions the finished task but is not its handoff.
	assert.deepEqual(verify.tasks[0].handoff, { source: "pushed-result", chars: 80, tokens: 20, tokensMethod: "estimate:ceil(chars/4)", deliveries: 1 });
});

test("lists tasks that cannot be linked to a session file instead of dropping them", async () => {
	const report = await analyze();
	// Tasks referenced by the parent come first, then records found only by parentSessionId.
	assert.deepEqual(report.unresolvedTasks.map((task) => [task.taskId, task.reason, task.referencedInParent]), [
		["task-z", "no-task-record", true],
		["task-d", "session-file-missing", false],
	]);
	assert.equal(report.unresolvedTasks[0].agent, "gone");
});

test("totals add the parent and every child", async () => {
	const { totals } = await analyze();
	assert.equal(totals.sessions, 3);
	assert.equal(totals.turns, 4 + 3 + 2);
	assert.equal(totals.zeroUsageTurns, 2);
	assert.deepEqual(totals.tokens, { input: 1055, cacheRead: 1940, cacheWrite: 160, output: 190 });
	assert.deepEqual(totals.cost, { api: 2399, nan: 3185 });
	assert.deepEqual(totals.children.cost, { api: 1956, nan: 2440 });
	assert.equal(totals.children.turns, 5);
});
