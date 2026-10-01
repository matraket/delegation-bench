#!/usr/bin/env node
// Builds the runner question files from a canonical question set.
//
//   node scripts/build-question-files.mjs [--set <set.json>] [--out <dir>]
//
// Outputs (under --out, default questions/generated/):
//   long.json            one session with every question and follow-up,
//                        largest questions first (large, medium, small);
//   short/<id>.json      one two-turn session per question.
// Each file carries the set id and commit, and a `cwd` relative to itself
// that points at the pinned worktree named by the set. Output is
// deterministic: the same set produces the same bytes.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DEFAULT_SET = join(REPO_ROOT, "questions", "gentle-shell-cc36bd8d.set.json");
export const DEFAULT_OUT = join(REPO_ROOT, "questions", "generated");

export const SIZES = ["small", "medium", "large"];
export const EXPECTED_SIZE_COUNTS = Object.freeze({ small: 4, medium: 4, large: 4 });
// Long-session order: the largest questions first, to maximize carried context.
const LONG_ORDER = ["large", "medium", "small"];
export const PROMPT_SUFFIX = "Answer in English.";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// "path:line" or "path:start-end", path relative to the target repository.
const EVIDENCE_PATTERN = /^[^\s:]+:\d+(?:-\d+)?$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function checkEvidence(list, where, errors, required) {
	if (list === undefined && !required) return;
	if (!Array.isArray(list) || list.length === 0) {
		errors.push(`${where}: evidence must be a non-empty array of "path:line" strings`);
		return;
	}
	for (const entry of list) {
		if (typeof entry !== "string" || !EVIDENCE_PATTERN.test(entry)) errors.push(`${where}: evidence ${JSON.stringify(entry)} must be "path:line" or "path:start-end"`);
		else {
			const [start, end] = entry.slice(entry.lastIndexOf(":") + 1).split("-").map(Number);
			if (start < 1 || (end !== undefined && end < start)) errors.push(`${where}: evidence ${JSON.stringify(entry)} has an invalid line range`);
		}
	}
}

function checkClaims(list, label, where, errors, evidenceRequired) {
	const ids = new Set();
	for (const [index, claim] of list.entries()) {
		const claimWhere = `${where}: ${label} ${isRecord(claim) && nonEmptyString(claim.id) ? `"${claim.id}"` : index + 1}`;
		if (!isRecord(claim)) {
			errors.push(`${claimWhere} must be an object`);
			continue;
		}
		if (!nonEmptyString(claim.id) || !ID_PATTERN.test(claim.id)) errors.push(`${claimWhere}: id must match ${ID_PATTERN}`);
		else if (ids.has(claim.id)) errors.push(`${where}: duplicate ${label} id "${claim.id}"`);
		else ids.add(claim.id);
		if (!nonEmptyString(claim.text)) errors.push(`${claimWhere}: text must be a non-empty string`);
		checkEvidence(claim.evidence, claimWhere, errors, evidenceRequired);
	}
	return ids;
}

function checkTurn(turn, where, errors) {
	if (!isRecord(turn)) {
		errors.push(`${where} must be an object with prompt and key`);
		return;
	}
	if (!nonEmptyString(turn.prompt)) errors.push(`${where}: prompt must be a non-empty string`);
	else if (!turn.prompt.trimEnd().endsWith(PROMPT_SUFFIX)) errors.push(`${where}: prompt must end with "${PROMPT_SUFFIX}"`);
	if (!isRecord(turn.key)) {
		errors.push(`${where}: key must be an object with facts`);
		return;
	}
	if (!Array.isArray(turn.key.facts) || turn.key.facts.length === 0) {
		errors.push(`${where}: key.facts must be a non-empty array`);
	} else {
		const factIds = checkClaims(turn.key.facts, "fact", where, errors, true);
		if (turn.key.forbidden !== undefined) {
			if (!Array.isArray(turn.key.forbidden)) errors.push(`${where}: key.forbidden must be an array when present`);
			else for (const id of checkClaims(turn.key.forbidden, "forbidden", where, errors, false)) {
				if (factIds.has(id)) errors.push(`${where}: forbidden id "${id}" repeats a fact id`);
			}
		}
	}
}

/** Throws one Error listing every problem in the set; returns the set when valid. */
export function validateSet(set) {
	const errors = [];
	if (!isRecord(set)) throw new Error("invalid question set:\n- the set must be a JSON object");
	if (!nonEmptyString(set.id) || !ID_PATTERN.test(set.id)) errors.push(`id must match ${ID_PATTERN}`);
	if (!isRecord(set.repository)) errors.push("repository must be an object with name, commit and worktree");
	else {
		if (!nonEmptyString(set.repository.name)) errors.push("repository.name must be a non-empty string");
		if (typeof set.repository.commit !== "string" || !/^[0-9a-f]{40}$/.test(set.repository.commit)) errors.push("repository.commit must be a full 40-character commit hash");
		if (!nonEmptyString(set.repository.worktree)) errors.push("repository.worktree must be a path relative to the set file");
		else if (set.repository.worktree.startsWith("/")) errors.push("repository.worktree must be relative to the set file, not absolute");
	}
	if (!Array.isArray(set.questions) || set.questions.length === 0) {
		errors.push("questions must be a non-empty array");
	} else {
		const ids = new Set();
		const counts = Object.fromEntries(SIZES.map((size) => [size, 0]));
		for (const [index, question] of set.questions.entries()) {
			const where = `question ${isRecord(question) && nonEmptyString(question.id) ? `"${question.id}"` : index + 1}`;
			if (!isRecord(question)) {
				errors.push(`${where} must be an object`);
				continue;
			}
			if (!nonEmptyString(question.id) || !ID_PATTERN.test(question.id)) errors.push(`${where}: id must match ${ID_PATTERN}`);
			else if (ids.has(question.id)) errors.push(`duplicate question id "${question.id}"`);
			else ids.add(question.id);
			if (!SIZES.includes(question.size)) errors.push(`${where}: size must be one of ${SIZES.join(", ")}`);
			else counts[question.size] += 1;
			checkTurn(question, where, errors);
			checkTurn(question.followup, `${where} followup`, errors);
		}
		const wrong = SIZES.filter((size) => counts[size] !== EXPECTED_SIZE_COUNTS[size]);
		if (wrong.length > 0) errors.push(`size counts: ${wrong.map((size) => `${size}: expected ${EXPECTED_SIZE_COUNTS[size]}, got ${counts[size]}`).join("; ")}`);
	}
	if (errors.length > 0) throw new Error(`invalid question set:\n- ${errors.join("\n- ")}`);
	return set;
}

function turnsOf(question) {
	return [
		{ id: question.id, prompt: question.prompt },
		{ id: `${question.id}-followup`, prompt: question.followup.prompt },
	];
}

function serialize(data) {
	return `${JSON.stringify(data, null, "\t")}\n`;
}

/**
 * Validates the set and returns Map<relative output path, file content>, in a
 * stable order: long.json first, then short/<id>.json in canonical order.
 */
export function buildQuestionFiles(set, { setPath, outDir }) {
	validateSet(set);
	const worktree = resolve(dirname(resolve(setPath)), set.repository.worktree);
	const cwdFrom = (name) => relative(dirname(join(resolve(outDir), name)), worktree);
	const common = { set: set.id, repository: set.repository.name, commit: set.repository.commit };
	const files = new Map();
	const ordered = LONG_ORDER.flatMap((size) => set.questions.filter((question) => question.size === size));
	files.set("long.json", serialize({
		id: `${set.id}/long`,
		...common,
		description: `All ${ordered.length} questions with their follow-ups in one session, largest first (generated by scripts/build-question-files.mjs; do not edit).`,
		cwd: cwdFrom("long.json"),
		turns: ordered.flatMap(turnsOf),
	}));
	for (const question of set.questions) {
		const name = `short/${question.id}.json`;
		files.set(name, serialize({
			id: `${set.id}/short/${question.id}`,
			...common,
			question: question.id,
			size: question.size,
			description: `One ${question.size} question and its follow-up (generated by scripts/build-question-files.mjs; do not edit).`,
			cwd: cwdFrom(name),
			turns: turnsOf(question),
		}));
	}
	return files;
}

/** Writes the generated files and removes stale short files. Returns the written paths. */
export async function writeQuestionFiles(set, { setPath, outDir }) {
	const files = buildQuestionFiles(set, { setPath, outDir });
	const shortDir = join(outDir, "short");
	await mkdir(shortDir, { recursive: true });
	for (const name of (await readdir(shortDir)).filter((entry) => entry.endsWith(".json"))) {
		if (!files.has(`short/${name}`)) await rm(join(shortDir, name));
	}
	for (const [name, content] of files) await writeFile(join(outDir, name), content);
	return [...files.keys()].map((name) => join(outDir, name));
}

export async function loadSet(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`cannot read question set ${path}: ${error.message}`);
	}
}

function parseArgs(argv) {
	const options = { set: DEFAULT_SET, out: DEFAULT_OUT };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--help" || flag === "-h") return { help: true };
		if (flag !== "--set" && flag !== "--out") throw new Error(`unknown option: ${flag}`);
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		options[flag.slice(2)] = resolve(value);
		index += 1;
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("Usage: node scripts/build-question-files.mjs [--set <set.json>] [--out <dir>]\n");
		return;
	}
	const set = await loadSet(options.set);
	const written = await writeQuestionFiles(set, { setPath: options.set, outDir: options.out });
	process.stdout.write(`build-question-files: wrote ${written.length} files to ${relative(process.cwd(), options.out) || "."} (set ${set.id}, commit ${set.repository.commit.slice(0, 12)})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		process.stderr.write(`build-question-files: ${error.message}\n`);
		process.exit(1);
	});
}
