import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Agent homes searched by default: Gentle Shell first, then plain pi. */
export function defaultAgentHomes(home) {
	return [join(home, ".gentle-shell", "agent"), join(home, ".pi", "agent")];
}

/**
 * Directories holding session files for one agent home:
 * - sessions/<cwd-slug>/*.jsonl for top-level sessions
 * - gentle-agents/sessions/*.jsonl for delegated child sessions
 */
export function sessionDirs(agentHome) {
	return [join(agentHome, "sessions"), join(agentHome, "gentle-agents", "sessions")];
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function listJsonl(dir, depth) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	// readdir order depends on the filesystem; sort so resolution is reproducible.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		else if (entry.isDirectory() && depth > 0) files.push(...(await listJsonl(path, depth - 1)));
	}
	return files;
}

/** Session id encoded in a pi session file name: <timestamp>_<id>.jsonl. */
export function sessionIdFromFile(path) {
	const name = basename(path, ".jsonl");
	const cut = name.indexOf("_");
	return cut === -1 ? name : name.slice(cut + 1);
}

/**
 * Every distinct session file for an id across every agent home, in a
 * deterministic order: agent homes as given, then sessionDirs order, then by
 * path name. Files are de-duplicated by real path, so a repeated or symlinked
 * agent home lists one file once (under the first path that reached it).
 */
export async function findSessionFilesById(id, agentHomes) {
	const matches = [];
	const seen = new Set();
	for (const home of agentHomes) {
		for (const dir of sessionDirs(home)) {
			for (const file of (await listJsonl(dir, 1)).filter((path) => sessionIdFromFile(path) === id)) {
				const real = await realpath(file).catch(() => file);
				if (seen.has(real)) continue;
				seen.add(real);
				matches.push(file);
			}
		}
	}
	return matches;
}

/**
 * The single session file for an id, or undefined when none exists. An id
 * found in more than one file is an error listing every candidate, because
 * picking one would silently analyze a session the caller may not mean.
 */
export async function findSessionById(id, agentHomes) {
	const matches = await findSessionFilesById(id, agentHomes);
	if (matches.length > 1) {
		throw new Error(`session id is ambiguous: ${id} matches ${matches.length} files; pass one path instead:\n${matches.map((file) => `  ${file}`).join("\n")}`);
	}
	return matches[0];
}

/** Accept a session file path or a session id. */
export async function resolveSessionArg(arg, agentHomes) {
	if (arg.endsWith(".jsonl") || arg.includes("/")) {
		const path = resolve(arg);
		if (await isFile(path)) return path;
		throw new Error(`session not found: ${arg}`);
	}
	const found = await findSessionById(arg, agentHomes);
	if (!found) throw new Error(`session not found: ${arg}`);
	return found;
}
