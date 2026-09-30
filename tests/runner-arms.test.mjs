import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARM_NAMES, SUBAGENT_TOOLS, applyLineMap, buildArm, loadOldRulesMap, replaceTriggerBlock } from "../lib/runner/arms.mjs";
import { DEFAULTS } from "../lib/runner/plan.mjs";
import { TEST_LINE_MAP, makeSource } from "./runner-helpers.mjs";

async function build(name, extra = {}) {
	const { source, donor, root } = await makeSource();
	const workDir = join(root, "work");
	const arm = await buildArm(name, { source, donor, workDir, oldRulesMap: TEST_LINE_MAP, ...extra });
	const read = (path) => readFile(join(arm.root, path), "utf8");
	return { arm, source, donor, workDir, read };
}

test("the six arms are defined in the documented order", () => {
	assert.deepEqual(ARM_NAMES, ["old-rules", "inline", "shipped", "shipped-nonlean", "delegate", "delegate-nonlean"]);
});

test("shipped is an unchanged copy with lean children", async () => {
	const { arm, source, read } = await build("shipped");
	assert.equal(await read("assets/orchestrator.md"), await readFile(join(source, "assets/orchestrator.md"), "utf8"));
	assert.ok(existsSync(join(arm.root, "extensions/child-context.ts")));
	assert.equal(arm.lean, true);
	assert.deepEqual(arm.excludeTools, []);
	assert.deepEqual(arm.patches, []);
	assert.ok(arm.orchestratorBytes > 0 && arm.orchestratorBytes <= 8192);
});

test("old-rules patches in the donor rule lines and records where", async () => {
	const { arm, source, read } = await build("old-rules");
	const orchestrator = await read("assets/orchestrator.md");
	assert.match(orchestrator, /^1\. \*\*4-file rule\*\* — 4\+ files to understand → delegate a scout\.$/m);
	assert.match(orchestrator, /^4\. \*\*Long-session rule\*\*/m);
	assert.doesNotMatch(orchestrator, /Evidence-budget rule|Context backstop/);
	assert.match(await read("assets/orchestrator-delegation.md"), /4-file rule\):\*\* donor text/);
	assert.deepEqual(
		arm.patches.map(({ file, shippedLine, donorLine }) => ({ file, shippedLine, donorLine })),
		[
			{ file: "assets/orchestrator.md", shippedLine: 6, donorLine: 6 },
			{ file: "assets/orchestrator.md", shippedLine: 8, donorLine: 8 },
			{ file: "assets/orchestrator-delegation.md", shippedLine: 2, donorLine: 2 },
		],
	);
	// The source release is never modified.
	assert.match(await readFile(join(source, "assets/orchestrator.md"), "utf8"), /Evidence-budget rule/);
});

test("inline replaces the trigger block with the forced-inline rule and excludes the subagent tools", async () => {
	const { arm, read } = await build("inline");
	const orchestrator = await read("assets/orchestrator.md");
	const rule = (await readFile(new URL("../arms/rules/inline.md", import.meta.url), "utf8")).trim();
	assert.ok(orchestrator.includes(rule));
	assert.doesNotMatch(orchestrator, /Mandatory Delegation Triggers|Evidence-budget rule|Verification rule/);
	assert.match(orchestrator, /\{\{GENTLE_PI_BACKGROUND_POLICY\}\}/);
	assert.deepEqual(arm.excludeTools, SUBAGENT_TOOLS);
	assert.ok(SUBAGENT_TOOLS.includes("subagent_run") && SUBAGENT_TOOLS.includes("subagent_continue"));
	assert.equal(arm.lean, true);
});

test("delegate and delegate-nonlean carry the forced-delegation rule; non-lean arms drop child-context.ts only", async () => {
	const rule = (await readFile(new URL("../arms/rules/delegate.md", import.meta.url), "utf8")).trim();
	for (const name of ["delegate", "delegate-nonlean"]) {
		const { arm, read } = await build(name);
		assert.ok((await read("assets/orchestrator.md")).includes(rule), name);
		assert.deepEqual(arm.excludeTools, []);
		assert.equal(existsSync(join(arm.root, "extensions/child-context.ts")), name === "delegate", name);
		assert.ok(existsSync(join(arm.root, "extensions/child-safety.ts")), name);
	}
	const { arm } = await build("shipped-nonlean");
	assert.equal(arm.lean, false);
	assert.ok(!existsSync(join(arm.root, "extensions/child-context.ts")));
	assert.ok(existsSync(join(arm.root, "extensions/child-safety.ts")));
});

test("node_modules is hardlinked (no .cache), symlinks are kept, package files are real copies", async () => {
	const { arm, source } = await build("shipped");
	const [armDep, srcDep] = await Promise.all([stat(join(arm.root, "node_modules/dep/index.js")), stat(join(source, "node_modules/dep/index.js"))]);
	assert.equal(armDep.ino, srcDep.ino);
	assert.deepEqual(await readdir(join(arm.root, "node_modules/.cache")), []);
	assert.ok((await lstat(join(arm.root, "node_modules/.bin/dep"))).isSymbolicLink());
	assert.equal(await readlink(join(arm.root, "node_modules/.bin/dep")), "../dep/index.js");
	const [armAsset, srcAsset] = await Promise.all([stat(join(arm.root, "assets/orchestrator.md")), stat(join(source, "assets/orchestrator.md"))]);
	assert.notEqual(armAsset.ino, srcAsset.ino);
	assert.equal(JSON.parse(await readFile(join(arm.root, "bench-arm.json"), "utf8")).arm, "shipped");
});

test("a source given through a symlink (like the watch `current` link) is copied as a real tree", async () => {
	const { source, donor, root } = await makeSource();
	const link = join(root, "current");
	await symlink(source, link);
	const arm = await buildArm("shipped", { source: link, donor, workDir: join(root, "work"), oldRulesMap: TEST_LINE_MAP });
	const info = await lstat(arm.root);
	assert.ok(info.isDirectory() && !info.isSymbolicLink());
	assert.equal(arm.source, source);
	assert.ok(existsSync(join(arm.root, "node_modules/dep/index.js")));
});

test("identical inputs reuse the existing arm root untouched", async () => {
	const { source, donor, root } = await makeSource();
	const workDir = join(root, "work");
	const first = await buildArm("shipped-nonlean", { source, donor, workDir, oldRulesMap: TEST_LINE_MAP });
	assert.equal(first.reused, false);
	// State a live run leaves in its package root (jiti writes node_modules/.cache).
	const sentinel = join(first.root, "node_modules/.cache/live-run.txt");
	await writeFile(sentinel, "in use");
	const before = await stat(first.root);
	const again = await buildArm("shipped-nonlean", { source, donor, workDir, oldRulesMap: TEST_LINE_MAP });
	assert.equal(again.root, first.root);
	assert.equal(again.reused, true);
	assert.equal(again.key, first.key);
	assert.equal(await readFile(sentinel, "utf8"), "in use");
	assert.equal((await stat(first.root)).ino, before.ino);
	assert.ok(!existsSync(join(again.root, "extensions/child-context.ts")));
});

test("changed inputs build a new arm root and never delete the previous one", async () => {
	const { source, donor, root } = await makeSource();
	const workDir = join(root, "work");
	const first = await buildArm("inline", { source, donor, workDir, oldRulesMap: TEST_LINE_MAP });
	const rulesDir = await mkdtemp(join(tmpdir(), "bench-rules-"));
	await writeFile(join(rulesDir, "inline.md"), "Always answer inline.\n");
	const second = await buildArm("inline", { source, donor, workDir, oldRulesMap: TEST_LINE_MAP, rulesDir });
	assert.notEqual(second.root, first.root);
	assert.match(await readFile(join(second.root, "assets/orchestrator.md"), "utf8"), /Always answer inline\./);
	assert.ok(existsSync(join(first.root, "bench-arm.json")));
	assert.doesNotMatch(await readFile(join(first.root, "assets/orchestrator.md"), "utf8"), /Always answer inline/);
	// A changed source package file changes the key even when no patch differs.
	await writeFile(join(source, "extensions/gentle-agents.ts"), "// changed release\n");
	const third = await buildArm("inline", { source, donor, workDir, oldRulesMap: TEST_LINE_MAP });
	assert.notEqual(third.root, first.root);
	assert.ok(existsSync(join(first.root, "bench-arm.json")));
	// Every root is named <arm>-<key> under <workDir>/arms, and no temporary build is left behind.
	assert.deepEqual((await readdir(join(workDir, "arms"))).sort(), [first.root, second.root, third.root].map((path) => path.split("/").pop()).sort());
	for (const arm of [first, second, third]) assert.match(arm.root.split("/").pop(), /^inline-[0-9a-f]{12}$/);
});

test("a rule text that breaks the 8 KiB orchestrator budget is refused", async () => {
	const rulesDir = await mkdtemp(join(tmpdir(), "bench-rules-"));
	await writeFile(join(rulesDir, "inline.md"), "x".repeat(9000));
	await assert.rejects(build("inline", { rulesDir }), /exceeds the 8192-byte orchestrator budget/);
});

test("unknown arms and drifted anchors fail loudly", async () => {
	await assert.rejects(build("nope"), /unknown arm: nope/);
	assert.throws(() => applyLineMap("a\nb\n", "c\n", [{ shipped: "zzz", donor: "c" }], "f.md"), /f\.md: expected exactly one shipped line starting with "zzz", found 0/);
	assert.throws(() => replaceTriggerBlock("no block here", "rule"), /trigger block/);
});

const { source: RELEASE, donor: DONOR } = DEFAULTS;

test("the real old-rules map turns the shipped orchestrator.md into the pre-#1590 one", { skip: !existsSync(join(RELEASE, "assets")) || !existsSync(join(DONOR, "assets")) }, async () => {
	const map = await loadOldRulesMap();
	for (const [file, entries] of Object.entries(map.files)) {
		const shipped = await readFile(join(RELEASE, file), "utf8");
		const donor = await readFile(join(DONOR, file), "utf8");
		const { text } = applyLineMap(shipped, donor, entries, file);
		assert.doesNotMatch(text, /Evidence-budget rule|Context backstop/, file);
		assert.match(text, /4-file rule/, file);
		if (file === "assets/orchestrator.md") assert.equal(text, donor);
	}
});
