import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// A fresh, isolated agent home per arm x repetition. Only these template
// paths are ever read: settings.json, npm/package.json, the kept npm package
// directories, and agents/*.md. Credentials (auth.json, models-store.json)
// and every other piece of home state are never read or copied.

export const DEFAULT_KEEP_PACKAGES = ["npm:@gtrabanco/pi-nan-provider"];
export const CONTEXT_FIXTURES = ["none", "managed-blocks"];
export const MANAGED_BLOCKS_FIXTURE = fileURLToPath(new URL("../../arms/fixtures/managed-blocks-AGENTS.md", import.meta.url));
// agents-config.ts defaults history_max_tasks to 200; child linkage needs every record.
export const HISTORY_MAX_TASKS = 1_000_000;
// The launcher adds this exclusion to homes it owns (Gentle Shell ships its own
// codemode tool); a pre-seeded bench home counts as foreign, so seed it here.
const BUILTIN_CODEMODE_EXCLUSION = "-builtin:codemode";

/** npm:<name>[@version] → name (scoped names keep their leading @). */
export function npmPackageName(source) {
	if (!source.startsWith("npm:")) throw new Error(`only npm packages can be kept in a bench home, got: ${source}`);
	const spec = source.slice(4);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

function splitModel(model) {
	const cut = model.indexOf("/");
	if (cut <= 0 || cut === model.length - 1) throw new Error(`model must be <provider>/<model>, got: ${model}`);
	return { provider: model.slice(0, cut), id: model.slice(cut + 1) };
}

async function readJson(path, label) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${label} (${path}): ${error.message}`);
	}
}

/**
 * options: template (agent home to copy from), dest (must not exist), model
 * (<provider>/<model> for the parent and every agent), thinking (optional
 * level for the parent default and every agent), contextFixture
 * ("none" | "managed-blocks"), keepPackages (npm sources to keep).
 */
export async function buildHome({ template, dest, model, thinking, contextFixture = "none", keepPackages = DEFAULT_KEEP_PACKAGES }) {
	if (!CONTEXT_FIXTURES.includes(contextFixture)) throw new Error(`unknown context fixture: ${contextFixture} (known: ${CONTEXT_FIXTURES.join(", ")})`);
	if (existsSync(dest)) throw new Error(`bench home already exists (each run needs a fresh one): ${dest}`);
	const { provider, id } = splitModel(model);
	const settings = await readJson(join(template, "settings.json"), "template settings.json");
	const npmManifest = existsSync(join(template, "npm", "package.json")) ? await readJson(join(template, "npm", "package.json"), "template npm/package.json") : {};
	const packages = keepPackages.map((source) => ({ source, name: npmPackageName(source) }));
	for (const { source, name } of packages) {
		if (!existsSync(join(template, "npm", "node_modules", name, "package.json"))) {
			throw new Error(`${source} is not installed in the template home (${join(template, "npm", "node_modules", name)}); pi would try to install it from the network`);
		}
	}
	const agentsDir = join(template, "agents");
	const agentFiles = existsSync(agentsDir) ? (await readdir(agentsDir)).filter((name) => name.endsWith(".md")).sort() : [];

	await mkdir(dest, { recursive: true });
	const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
	const homeSettings = {
		...settings,
		packages: packages.map(({ source }) => source),
		extensions: extensions.some((entry) => typeof entry === "string" && entry.replace(/^[+!-]/, "") === "builtin:codemode") ? extensions : [...extensions, BUILTIN_CODEMODE_EXCLUSION],
		defaultProvider: provider,
		defaultModel: id,
		...(thinking ? { defaultThinkingLevel: thinking } : {}),
	};
	await writeFile(join(dest, "settings.json"), `${JSON.stringify(homeSettings, null, 2)}\n`);

	const dependencies = {};
	for (const { name } of packages) {
		dependencies[name] = npmManifest.dependencies?.[name] ?? "*";
		await cp(join(template, "npm", "node_modules", name), join(dest, "npm", "node_modules", name), { recursive: true, verbatimSymlinks: true });
	}
	await writeFile(join(dest, "npm", "package.json"), `${JSON.stringify({ name: "pi-extensions", private: true, dependencies }, null, 2)}\n`);

	await mkdir(join(dest, "agents"), { recursive: true });
	for (const file of agentFiles) await cp(join(agentsDir, file), join(dest, "agents", file));
	const profile = { model, ...(thinking ? { effort: thinking } : {}) };
	const subagents = {
		default_model: model,
		...(thinking ? { default_effort: thinking } : {}),
		history_max_tasks: HISTORY_MAX_TASKS,
		model_profiles: Object.fromEntries(agentFiles.map((file) => [basename(file, ".md"), { ...profile }])),
	};
	await writeFile(join(dest, "subagents.json"), `${JSON.stringify(subagents, null, 2)}\n`);

	let contextFile = null;
	if (contextFixture === "managed-blocks") {
		contextFile = join(dest, "AGENTS.md");
		await cp(MANAGED_BLOCKS_FIXTURE, contextFile);
	}
	const sessionDir = join(dest, "sessions", "bench");
	await mkdir(sessionDir, { recursive: true });
	return { home: dest, sessionDir, contextFile, packages: homeSettings.packages, agents: agentFiles.map((file) => basename(file, ".md")) };
}
