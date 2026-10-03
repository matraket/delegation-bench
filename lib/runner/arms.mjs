import { createHash, randomBytes } from "node:crypto";
import { cp, link, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
//
// Arm roots are immutable and content-keyed: <workDir>/arms/<arm>-<key>, where
// key hashes the builder version, the arm, the source real path, a source
// fingerprint and every patched text. Identical inputs reuse the existing
// root; changed inputs build a new one. No invocation (dry run included)
// deletes or rewrites a finished root, so a live run or an earlier manifest
// never loses its package root. A build happens in a temporary directory and
// is renamed into place only when complete (bench-arm.json written last).

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
const ARM_INFO = "bench-arm.json";
// Bump when the builder's output changes for the same inputs.
export const ARM_BUILDER_VERSION = 2;
const KEY_LENGTH = 12;

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

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Fingerprint of a source release: the content of every package file outside
 * node_modules, plus path, size and mtime of every node_modules file (those
 * are hardlinked, not copied) and every symlink target. node_modules/.cache
 * is skipped (it is never copied).
 */
export async function sourceFingerprint(source) {
	async function walk(dir, rel, inModules) {
		const entries = (await readdir(dir, { withFileTypes: true })).sort(byName);
		const parts = await Promise.all(
			entries.map(async (entry) => {
				const relPath = rel ? `${rel}/${entry.name}` : entry.name;
				const path = join(dir, entry.name);
				if (relPath === "node_modules/.cache") return "";
				if (entry.isSymbolicLink()) return `L ${relPath} ${await readlink(path)}\n`;
				if (entry.isDirectory()) return `D ${relPath}\n${await walk(path, relPath, inModules || relPath === "node_modules")}`;
				if (!entry.isFile()) return "";
				if (inModules) {
					const info = await stat(path);
					return `M ${relPath} ${info.size} ${info.mtimeMs}\n`;
				}
				return `F ${relPath} ${sha256(await readFile(path))}\n`;
			}),
		);
		return parts.join("");
	}
	return sha256(await walk(source, "", false));
}

async function readArmInfo(root) {
	try {
		return JSON.parse(await readFile(join(root, ARM_INFO), "utf8"));
	} catch {
		return undefined;
	}
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
 * Build (or reuse) one arm at <workDir>/arms/<name>-<key>; never replaces or
 * deletes an existing root. options: source (release root), donor (pre-#1590
 * release root, old-rules only), workDir, oldRulesMap (object), rulesDir
 * (inline.md / delegate.md), fingerprints (optional Map from source real path
 * to fingerprint, shared by the arms of one invocation).
 * Returns the arm info with key and reused (true when an identical build existed).
 */
export async function buildArm(name, { source: sourceArg, donor: donorArg, workDir, oldRulesMap, rulesDir = DEFAULT_RULES_DIR, fingerprints = new Map() }) {
	const arm = armDefinition(name);
	if (!existsSync(join(sourceArg, ORCHESTRATOR))) throw new Error(`source release has no ${ORCHESTRATOR}: ${sourceArg}`);
	// A source may be given through a symlink (for example a `current` link to a release); work on real paths.
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
	const removed = arm.lean ? [] : [CHILD_CONTEXT];

	if (!fingerprints.has(source)) fingerprints.set(source, await sourceFingerprint(source));
	const keyInputs = {
		builder: ARM_BUILDER_VERSION,
		arm: { name, rules: arm.rules, lean: arm.lean },
		source,
		sourceFingerprint: fingerprints.get(source),
		patched: [...patched].map(([file, text]) => [file, sha256(text)]).sort(),
		removed,
	};
	const key = sha256(JSON.stringify(keyInputs)).slice(0, KEY_LENGTH);
	const armsDir = join(workDir, "arms");
	const root = join(armsDir, `${name}-${key}`);
	const existing = await readArmInfo(root);
	if (existing?.key === key) return { name, ...existing, reused: true };
	if (existsSync(root)) throw new Error(`${root} exists but is not a complete build of this arm (no matching ${ARM_INFO}); check that no run uses it, then remove it by hand`);

	// Rendered with the final root: the host substitutes the package root in use.
	const orchestratorBytes = renderedOrchestratorBytes(orchestrator, join(root, "assets"));
	if (orchestratorBytes > ORCHESTRATOR_BUDGET_BYTES) {
		throw new Error(`arm ${name}: ${ORCHESTRATOR} renders to ${orchestratorBytes} bytes, which exceeds the ${ORCHESTRATOR_BUDGET_BYTES}-byte orchestrator budget`);
	}

	await mkdir(armsDir, { recursive: true });
	const temp = join(armsDir, `.build-${name}-${key}-${process.pid}-${randomBytes(4).toString("hex")}`);
	let info;
	try {
		const linkStats = await copyPackage(source, temp);
		for (const [file, text] of patched) await writePatched(temp, source, file, text);
		for (const file of removed) await rm(join(temp, file));
		info = {
			arm: name,
			key,
			root,
			rules: arm.rules,
			lean: arm.lean,
			excludeTools: arm.excludeTools,
			source,
			sourceVersion: JSON.parse(await readFile(join(source, "package.json"), "utf8")).version ?? null,
			sourceFingerprint: keyInputs.sourceFingerprint,
			donor: arm.rules === "old-rules" ? donor : null,
			patches,
			removed,
			orchestratorBytes,
			budgetBytes: ORCHESTRATOR_BUDGET_BYTES,
			linkStats,
			builtAt: new Date().toISOString(),
		};
		await writeFile(join(temp, ARM_INFO), `${JSON.stringify(info, null, "\t")}\n`);
		// rename refuses a non-empty target, so a finished root is never replaced.
		await rename(temp, root);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		// Another invocation finished the identical build first: use it.
		const winner = await readArmInfo(root);
		if (winner?.key === key) return { name, ...winner, reused: true };
		throw error;
	}
	return { name, ...info, reused: false };
}

export async function buildArms(names, options) {
	const fingerprints = options.fingerprints ?? new Map();
	const arms = [];
	for (const name of names) arms.push(await buildArm(name, { ...options, fingerprints }));
	return arms;
}
