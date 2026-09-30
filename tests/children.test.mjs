import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverChildren } from "../lib/children.mjs";
import { CHILD1_PATH } from "./helpers.mjs";

test("follows the recorded sessionPath when it exists, ahead of the basename fallback", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "delegation-bench-children-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "agent");
	// The recorded child file lives outside the agent home, where only the recorded path can reach it.
	const recordedPath = join(root, "elsewhere", basename(CHILD1_PATH));
	// A same-named file under the agent home would win if the recorded path were ignored.
	const fallbackPath = join(home, "gentle-agents", "sessions", basename(CHILD1_PATH));
	for (const file of [recordedPath, fallbackPath]) {
		await mkdir(join(file, ".."), { recursive: true });
		await copyFile(CHILD1_PATH, file);
	}
	const tasksDir = join(home, "gentle-agents", "tasks");
	await mkdir(tasksDir, { recursive: true });
	const task = { id: "task-r", agent: "explore", mode: "task", parentSessionId: "parent-r", status: "completed", createdAt: 1, sessionPath: recordedPath, result: "done" };
	await writeFile(join(tasksDir, "task-r.json"), JSON.stringify({ task }));

	const { children, unresolvedTasks } = await discoverChildren({ id: "parent-r", entries: [] }, [home]);

	assert.deepEqual(unresolvedTasks, []);
	assert.equal(children.length, 1);
	assert.equal(children[0].path, recordedPath);
	assert.equal(children[0].pathResolvedBy, "recorded");
	assert.deepEqual(children[0].tasks.map((entry) => entry.taskId), ["task-r"]);
});
