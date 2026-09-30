import { cp, link, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Arms are per-arm copies of the Gentle Shell package, selected at launch with
// `--package-root`. assets/orchestrator.md is read from the package root and
// appended to the primary session only, so rule variants must live in the
// package copy. Package files are real copies (safe to patch); node_modules
// is hardlinked to the source release to avoid duplicating ~225 MB per arm,
// except node_modules/.cache (jiti writes there at runtime, and an in-place
// write through a hardlink would modify the source release).

const ARMS_DIR = fileURLToPath(new URL("../../arms/", import.meta.url));
export const DEFAULT_RULES_DIR = join(ARMS_DIR, "rules");
export const DEFAULT_OLD_RULES_MAP = join(ARMS_DIR, "old-rules.json");

export const ARM_NAMES = ["old-rules", "inline", "shipped", "shipped-nonlean", "delegate", "delegate-nonlean"];

// Tools registered by extensions/gentle-agents.ts (TOOL_PREFIX "subagent_"),
// in registration order. subagent_parent_message exists only inside children.
export const SUBAGENT_TOOLS = [
	"subagent_list_agents",
	"subagent_run",
	"subagent_status",
	"subagent_result",
	"subagent_list_tasks",
	"subagent_reply",
	"subagent_cancel",
	"subagent_send_message",
	"subagent_continue",
];

const ARMS = {
	"old-rules": { rules: "old-rules", lean: true, excludeTools: [] },
	inline: { rules: "inline", lean: true, excludeTools: SUBAGENT_TOOLS },
	shipped: { rules: "shipped", lean: true, excludeTools: [] },
	"shipped-nonlean": { rules: "shipped", lean: false, excludeTools: [] },
	delegate: { rules: "delegate", lean: true, excludeTools: [] },
	"delegate-nonlean": { rules: "delegate", lean: false, excludeTools: [] },
};

// tests/orchestrator-budget.test.ts in the release: the rendered core prompt
// must stay within 8 KiB.
export const ORCHESTRATOR_BUDGET_BYTES = 8192;
const ORCHESTRATOR = "assets/orchestrator.md";
const CHILD_CONTEXT = "extensions/child-context.ts";
const TRIGGER_START = "Mandatory Delegation Triggers";
const TRIGGER_END = "5. **Verification rule**";

export function armDefinition(name) {
	if (!Object.hasOwn(ARMS, name)) throw new Error(`unknown arm: ${name} (known: ${ARM_NAMES.join(", ")})`);
	return { name, ...ARMS[name], excludeTools: [...ARMS[name].excludeTools] };
}

function uniqueLine(lines, prefix, label, kind) {
	const hits = [];
	lines.forEach((line, index) => {
		if (line.startsWith(prefix)) hits.push(index);
	});
	if (hits.length !== 1) throw new Error(`${label}: expected exactly one ${kind} line starting with "${prefix}", found ${hits.length}`);
	return hits[0];
}

/**
 * Replace whole lines of the shipped text with whole lines of the donor text.
 * entries: [{shipped, donor}] line-start anchors, each unique in its file.
 * Returns the new text and 1-based line numbers of every replacement.
 */
export function applyLineMap(shippedText, donorText, entries, label) {
	const lines = shippedText.split("\n");
	const donor = donorText.split("\n");
	const applied = [];
	for (const entry of entries) {
		const at = uniqueLine(lines, entry.shipped, label, "shipped");
		const from = uniqueLine(donor, entry.donor, label, "donor");
		if (lines[at] === donor[from]) throw new Error(`${label}: anchor "${entry.shipped}" already equals the donor line; the map changes nothing`);
		lines[at] = donor[from];
		applied.push({ file: label, shippedLine: at + 1, donorLine: from + 1, anchor: entry.shipped });
	}
	return { text: lines.join("\n"), applied };
}

/** Replace the Mandatory Delegation Triggers block (through rule 5) with ruleText. */
export function replaceTriggerBlock(text, ruleText) {
	const lines = text.split("\n");
	const starts = lines.flatMap((line, index) => (line.startsWith(TRIGGER_START) ? [index] : []));
	const end = starts.length === 1 ? lines.findIndex((line, index) => index > starts[0] && line.startsWith(TRIGGER_END)) : -1;
	if (starts.length !== 1 || end === -1) throw new Error(`${ORCHESTRATOR}: cannot find one trigger block from "${TRIGGER_START}" to "${TRIGGER_END}"`);
	lines.splice(starts[0], end - starts[0] + 1, ...ruleText.trimEnd().split("\n"));
	return lines.join("\n");
}

export async function loadOldRulesMap(path = DEFAULT_OLD_RULES_MAP) {
	const map = JSON.parse(await readFile(path, "utf8"));
	if (!map?.files || typeof map.files !== "object") throw new Error(`${path}: expected {"files": {<asset>: [{shipped, donor}]}}`);
	return map;
}

/** Bytes of orchestrator.md as rendered for the primary session (assets root substituted). */
export function renderedOrchestratorBytes(text, assetsDir) {
	return Buffer.byteLength(text.replaceAll("{{GENTLE_PI_ASSETS_ROOT}}", assetsDir), "utf8");
}

const LINK_FALLBACK = new Set(["EXDEV", "EPERM", "EMLINK", "ENOTSUP"]);

async function linkTree(src, dest, stats, skip = new Set()) {
	await mkdir(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	await Promise.all(
		entries.map(async (entry) => {
			const from = join(src, entry.name);
			const to = join(dest, entry.name);
			if (skip.has(entry.name)) {
				await mkdir(to, { recursive: true });
			} else if (entry.isSymbolicLink()) {
				await symlink(await readlink(from), to);
			} else if (entry.isDirectory()) {
				await linkTree(from, to, stats);
			} else if (entry.isFile()) {
				try {
					await link(from, to);
					stats.linked += 1;
				} catch (error) {
					if (!LINK_FALLBACK.has(error.code)) throw error;
					await copyFile(from, to);
					stats.copied += 1;
				}
			}
		}),
	);
}

// source must be a real path: fs.cp with verbatimSymlinks copies a symlinked
// root as a link, and linking node_modules through it would target the source.
async function copyPackage(source, dest) {
	const modules = join(source, "node_modules");
	await cp(source, dest, { recursive: true, verbatimSymlinks: true, filter: (from) => from !== modules });
	const copied = await lstat(dest);
	if (!copied.isDirectory() || copied.isSymbolicLink()) throw new Error(`arm copy is not a real directory: ${dest}`);
	const stats = { linked: 0, copied: 0 };
	if (existsSync(modules)) await linkTree(modules, join(dest, "node_modules"), stats, new Set([".cache"]));
	return stats;
}

/** Write a patched file as a new inode, never through a link to the source. */
async function writePatched(root, source, file, text) {
	const target = join(root, file);
	await rm(target, { force: true });
	await writeFile(target, text);
	const [written, original] = await Promise.all([stat(target), stat(join(source, file))]);
	if (written.ino === original.ino && written.dev === original.dev) throw new Error(`${file}: patched copy shares an inode with the source release`);
}

/**
 * Build one arm under <workDir>/arms/<name>, replacing any previous copy.
 * options: source (release root), donor (pre-#1590 release root, old-rules
 * only), workDir, oldRulesMap (object), rulesDir (inline.md / delegate.md).
 */
export async function buildArm(name, { source: sourceArg, donor: donorArg, workDir, oldRulesMap, rulesDir = DEFAULT_RULES_DIR }) {
	const arm = armDefinition(name);
	const root = join(workDir, "arms", name);
	if (!existsSync(join(sourceArg, ORCHESTRATOR))) throw new Error(`source release has no ${ORCHESTRATOR}: ${sourceArg}`);
	// The watch directory's `current` is a symlink to the release; work on real paths.
	const source = await realpath(sourceArg);
	const donor = donorArg && existsSync(donorArg) ? await realpath(donorArg) : donorArg;

	// Compute every patched file first, so a bad rule or map fails before copying.
	const patched = new Map();
	const patches = [];
	let orchestrator = await readFile(join(source, ORCHESTRATOR), "utf8");
	if (arm.rules === "old-rules") {
		if (!donor || !existsSync(donor)) throw new Error(`old-rules needs the donor release (pre-#1590 assets): ${donor}`);
		const map = oldRulesMap ?? (await loadOldRulesMap());
		for (const [file, entries] of Object.entries(map.files)) {
			const shippedText = file === ORCHESTRATOR ? orchestrator : await readFile(join(source, file), "utf8");
			const { text, applied } = applyLineMap(shippedText, await readFile(join(donor, file), "utf8"), entries, file);
			patched.set(file, text);
			patches.push(...applied);
			if (file === ORCHESTRATOR) orchestrator = text;
		}
	} else if (arm.rules === "inline" || arm.rules === "delegate") {
		const rulesFile = join(rulesDir, `${arm.rules}.md`);
		orchestrator = replaceTriggerBlock(orchestrator, await readFile(rulesFile, "utf8"));
		patched.set(ORCHESTRATOR, orchestrator);
		patches.push({ file: ORCHESTRATOR, replacedBlock: `${TRIGGER_START} .. ${TRIGGER_END}`, rulesFile });
	}
	const orchestratorBytes = renderedOrchestratorBytes(orchestrator, join(root, "assets"));
	if (orchestratorBytes > ORCHESTRATOR_BUDGET_BYTES) {
		throw new Error(`arm ${name}: ${ORCHESTRATOR} renders to ${orchestratorBytes} bytes, which exceeds the ${ORCHESTRATOR_BUDGET_BYTES}-byte orchestrator budget`);
	}

	await rm(root, { recursive: true, force: true });
	await mkdir(join(workDir, "arms"), { recursive: true });
	const linkStats = await copyPackage(source, root);
	for (const [file, text] of patched) await writePatched(root, source, file, text);
	const removed = [];
	if (!arm.lean) {
		await rm(join(root, CHILD_CONTEXT));
		removed.push(CHILD_CONTEXT);
	}

	const info = {
		arm: name,
		root,
		rules: arm.rules,
		lean: arm.lean,
		excludeTools: arm.excludeTools,
		source,
		sourceVersion: JSON.parse(await readFile(join(source, "package.json"), "utf8")).version ?? null,
		donor: arm.rules === "old-rules" ? donor : null,
		patches,
		removed,
		orchestratorBytes,
		budgetBytes: ORCHESTRATOR_BUDGET_BYTES,
		linkStats,
		builtAt: new Date().toISOString(),
	};
	await writeFile(join(root, "bench-arm.json"), `${JSON.stringify(info, null, "\t")}\n`);
	return { name, ...info };
}

export async function buildArms(names, options) {
	const arms = [];
	for (const name of names) arms.push(await buildArm(name, options));
	return arms;
}
