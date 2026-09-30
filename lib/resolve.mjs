import { readdir, stat } from "node:fs/promises";
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

/** Find the session file for an id across every agent home. */
export async function findSessionById(id, agentHomes) {
	for (const home of agentHomes) {
		for (const dir of sessionDirs(home)) {
			const match = (await listJsonl(dir, 1)).find((file) => sessionIdFromFile(file) === id);
			if (match) return match;
		}
	}
	return undefined;
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
