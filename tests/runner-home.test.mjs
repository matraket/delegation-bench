import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHome } from "../lib/runner/home.mjs";
import { SECRET, makeTemplateHome } from "./runner-helpers.mjs";

async function allFiles(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
	}
	return out;
}

const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("builds a fresh isolated home: NaN provider only, agents, and every agent routed to the run model", async () => {
	const template = await makeTemplateHome();
	const dest = join(template, "..", `home-${Date.now()}`);
	const home = await buildHome({ template, dest, model: "nan/glm5.3-flash", thinking: "high", contextFixture: "none" });
	assert.equal(home.home, dest);
	assert.equal(home.sessionDir, join(dest, "sessions", "bench"));

	const settings = await json(join(dest, "settings.json"));
	assert.deepEqual(settings.packages, ["npm:@gtrabanco/pi-nan-provider"]);
	assert.equal(settings.defaultProvider, "nan");
	assert.equal(settings.defaultModel, "glm5.3-flash");
	assert.equal(settings.defaultThinkingLevel, "high");
	assert.deepEqual(settings.extensions, ["-builtin:codemode"]);
	assert.equal(settings.theme, "Gentleman-Cute");

	assert.ok(existsSync(join(dest, "npm/node_modules/@gtrabanco/pi-nan-provider/src/index.ts")));
	assert.ok(!existsSync(join(dest, "npm/node_modules/gentle-engram")));
	assert.deepEqual((await json(join(dest, "npm/package.json"))).dependencies, { "@gtrabanco/pi-nan-provider": "^0.10.0" });

	assert.deepEqual((await readdir(join(dest, "agents"))).sort(), ["gentle-ai-explore.md", "gentle-ai-worker.md"]);
	const subagents = await json(join(dest, "subagents.json"));
	assert.equal(subagents.default_model, "nan/glm5.3-flash");
	assert.ok(subagents.history_max_tasks >= 100000);
	assert.deepEqual(subagents.model_profiles, {
		"gentle-ai-explore": { model: "nan/glm5.3-flash", effort: "high" },
		"gentle-ai-worker": { model: "nan/glm5.3-flash", effort: "high" },
	});
	assert.ok(!existsSync(join(dest, "AGENTS.md")));
});

test("never copies credentials or other home state", async () => {
	const template = await makeTemplateHome();
	const dest = join(template, "..", `home-secret-${Date.now()}`);
	await buildHome({ template, dest, model: "nan/glm5.3-flash", contextFixture: "none" });
	assert.ok(!existsSync(join(dest, "auth.json")));
	assert.ok(!existsSync(join(dest, "models-store.json")));
	for (const file of await allFiles(dest)) assert.ok(!(await readFile(file, "utf8")).includes(SECRET), file);
});

test("managed-blocks seeds the agent-home AGENTS.md with gentle-ai managed block markers", async () => {
	const template = await makeTemplateHome();
	const dest = join(template, "..", `home-blocks-${Date.now()}`);
	const home = await buildHome({ template, dest, model: "nan/glm5.3-flash", contextFixture: "managed-blocks" });
	const agents = await readFile(join(dest, "AGENTS.md"), "utf8");
	assert.equal(home.contextFile, join(dest, "AGENTS.md"));
	for (const block of ["orchestrator", "sdd-orchestrator", "sdd-model-assignments", "agent-routing"]) {
		assert.match(agents, new RegExp(`^<!-- gentle-ai:${block} -->$`, "m"));
		assert.match(agents, new RegExp(`^<!-- /gentle-ai:${block} -->$`, "m"));
	}
});

test("refuses a reused home, a missing kept package and an unknown context fixture", async () => {
	const template = await makeTemplateHome();
	const dest = join(template, "..", `home-reuse-${Date.now()}`);
	await buildHome({ template, dest, model: "nan/glm5.3-flash", contextFixture: "none" });
	await assert.rejects(buildHome({ template, dest, model: "nan/glm5.3-flash", contextFixture: "none" }), /already exists/);
	await assert.rejects(buildHome({ template, dest: `${dest}-b`, model: "nan/glm5.3-flash", contextFixture: "none", keepPackages: ["npm:not-installed"] }), /npm:not-installed is not installed in the template home/);
	await assert.rejects(buildHome({ template, dest: `${dest}-c`, model: "nan/glm5.3-flash", contextFixture: "bogus" }), /unknown context fixture: bogus/);
});
