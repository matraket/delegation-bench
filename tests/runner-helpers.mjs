// Synthetic Gentle Shell package, donor release and template home for runner
// tests, so no test depends on the machine's installed release.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function put(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

// Line map used with the synthetic assets (the real map lives in arms/old-rules.json).
// The CLI tests pass the same file with --old-rules-map.
export const TEST_LINE_MAP_PATH = fileURLToPath(new URL("./fixtures/old-rules.test.json", import.meta.url));
export const TEST_LINE_MAP = JSON.parse(readFileSync(TEST_LINE_MAP_PATH, "utf8"));

const SHIPPED_ORCHESTRATOR = [
	"# Orchestrator",
	"Package assets root: `{{GENTLE_PI_ASSETS_ROOT}}`.",
	"",
	"Mandatory Delegation Triggers — once fired, delegate:",
	"",
	"1. **Evidence-budget rule** — read inline only within the budget.",
	"2. **Multi-file write rule** — 2+ files → writer.",
	"4. **Context backstop** — past ~150k tokens → delegate.",
	"5. **Verification rule** — verification → gentle-ai-verify.",
	"",
	"{{GENTLE_PI_BACKGROUND_POLICY}}; rules: see delegation contract.",
	"",
].join("\n");

const DONOR_ORCHESTRATOR = SHIPPED_ORCHESTRATOR.replace("1. **Evidence-budget rule** — read inline only within the budget.", "1. **4-file rule** — 4+ files to understand → delegate a scout.").replace(
	"4. **Context backstop** — past ~150k tokens → delegate.",
	"4. **Long-session rule** — ~20 tool calls → pause and delegate.",
);

/** A package tree shaped like the Gentle Shell release, plus a donor release. */
export async function makeSource() {
	const root = await mkdtemp(join(tmpdir(), "bench-src-"));
	const source = join(root, "release");
	const donor = join(root, "donor");
	await put(join(source, "package.json"), JSON.stringify({ name: "gentle-pi", version: "0.0.0-test" }));
	await put(join(source, "bin", "gentle-shell.mjs"), "// launcher placeholder\n");
	await put(join(source, "assets", "orchestrator.md"), SHIPPED_ORCHESTRATOR);
	await put(join(source, "assets", "orchestrator-delegation.md"), "intro\n1. **Mapping trigger (Evidence-budget rule):** shipped text\nend\n");
	for (const name of ["child-context.ts", "child-safety.ts", "gentle-agents.ts"]) await put(join(source, "extensions", name), `// ${name}\n`);
	await put(join(source, "node_modules", "dep", "index.js"), "export default 1;\n");
	await put(join(source, "node_modules", ".cache", "jiti", "cached.mjs"), "// jiti cache\n");
	await mkdir(join(source, "node_modules", ".bin"), { recursive: true });
	await symlink("../dep/index.js", join(source, "node_modules", ".bin", "dep"));
	await put(join(donor, "assets", "orchestrator.md"), DONOR_ORCHESTRATOR);
	await put(join(donor, "assets", "orchestrator-delegation.md"), "intro\n1. **Mapping trigger (4-file rule):** donor text\nend\n");
	return { root, source, donor };
}

export const SECRET = "TOPSECRET-should-never-be-copied";

/** A template agent home shaped like ~/.gentle-shell/agent, with credential decoys. */
export async function makeTemplateHome() {
	const template = await mkdtemp(join(tmpdir(), "bench-tpl-"));
	await put(
		join(template, "settings.json"),
		JSON.stringify({ lastChangelogVersion: "0.99.1", packages: ["npm:gentle-engram", "npm:@gtrabanco/pi-nan-provider", "npm:pi-claude-bridge@0.9.0"], extensions: ["/private/user-extension.ts"], theme: "Gentleman-Cute", tuiMode: "fullscreen", defaultProvider: "other", defaultModel: "other-model", defaultThinkingLevel: "low" }),
	);
	await put(join(template, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies: { "@gtrabanco/pi-nan-provider": "^0.10.0", "gentle-engram": "^0.1.16" } }));
	await put(join(template, "npm", "node_modules", "@gtrabanco", "pi-nan-provider", "package.json"), JSON.stringify({ name: "@gtrabanco/pi-nan-provider", version: "0.10.0" }));
	await put(join(template, "npm", "node_modules", "@gtrabanco", "pi-nan-provider", "src", "index.ts"), "export default () => {};\n");
	await put(join(template, "npm", "node_modules", "gentle-engram", "package.json"), JSON.stringify({ name: "gentle-engram" }));
	await put(join(template, "agents", "gentle-ai-explore.md"), "---\nname: gentle-ai-explore\n---\nexplore\n");
	await put(join(template, "agents", "gentle-ai-worker.md"), "---\nname: gentle-ai-worker\n---\nwork\n");
	await put(join(template, "subagents.json"), JSON.stringify({ model_profiles: { "gentle-ai-explore": { model: "other/model" } } }));
	await put(join(template, "auth.json"), JSON.stringify({ nan: { key: SECRET } }));
	await put(join(template, "models-store.json"), JSON.stringify({ token: SECRET }));
	return template;
}
