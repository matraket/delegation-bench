import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildQuestionFiles, EXPECTED_SIZE_COUNTS, validateSet, writeQuestionFiles } from "../scripts/build-question-files.mjs";
import { loadQuestions } from "../lib/runner/plan.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SET_PATH = join(ROOT, "questions", "gentle-shell-cc36bd8d.set.json");
const OUT_DIR = join(ROOT, "questions", "generated");
const BUILDER = join(ROOT, "scripts", "build-question-files.mjs");
const SET = JSON.parse(readFileSync(SET_PATH, "utf8"));
const WORKTREE = resolve(dirname(SET_PATH), SET.repository.worktree);
const HAS_WORKTREE = existsSync(WORKTREE);
const SIZE_ORDER = ["large", "medium", "small"];

function clone(value) {
	return structuredClone(value);
}

/** A minimal valid set with the expected size counts, for validation tests. */
function syntheticSet() {
	const key = (label) => ({ facts: [{ id: "f1", text: `${label} fact`, evidence: ["lib/a.ts:1-2"] }] });
	const questions = [];
	for (const size of ["small", "medium", "large"]) {
		for (let index = 1; index <= EXPECTED_SIZE_COUNTS[size]; index += 1) {
			const id = `${size[0]}${index}-q`;
			questions.push({ id, size, prompt: `Question ${id}? Answer in English.`, key: key(id), followup: { prompt: `Detail ${id}? Answer in English.`, key: key(`${id} followup`) } });
		}
	}
	return { id: "synthetic", repository: { name: "repo", commit: "a".repeat(40), worktree: "../target" }, questions };
}

function expectInvalid(set, pattern) {
	assert.throws(() => validateSet(set), (error) => {
		assert.match(error.message, pattern);
		return true;
	});
}

test("the canonical set is valid: 4 small, 4 medium, 4 large, all prompts in English", () => {
	validateSet(SET);
	const counts = {};
	for (const question of SET.questions) counts[question.size] = (counts[question.size] ?? 0) + 1;
	assert.deepEqual(counts, { small: 4, medium: 4, large: 4 });
	assert.match(SET.repository.commit, /^[0-9a-f]{40}$/);
});

test("long.json holds all 24 turns, largest questions first, each followed by its follow-up", () => {
	const files = buildQuestionFiles(SET, { setPath: SET_PATH, outDir: OUT_DIR });
	const long = JSON.parse(files.get("long.json"));
	assert.equal(long.turns.length, 24);
	assert.equal(long.set, SET.id);
	assert.equal(long.commit, SET.repository.commit);
	const bySize = new Map(SET.questions.map((question) => [question.id, question]));
	const sizes = [];
	for (let index = 0; index < long.turns.length; index += 2) {
		const question = bySize.get(long.turns[index].id);
		assert.ok(question, `turn ${long.turns[index].id} is a question`);
		assert.equal(long.turns[index].prompt, question.prompt);
		assert.equal(long.turns[index + 1].id, `${question.id}-followup`);
		assert.equal(long.turns[index + 1].prompt, question.followup.prompt);
		sizes.push(question.size);
	}
	const ranks = sizes.map((size) => SIZE_ORDER.indexOf(size));
	assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `sizes in order: ${sizes.join(",")}`);
	assert.deepEqual(sizes.slice(0, 4), ["large", "large", "large", "large"]);
	// Within a size class the canonical order is kept.
	const canonicalLarge = SET.questions.filter((question) => question.size === "large").map((question) => question.id);
	assert.deepEqual(long.turns.filter((_turn, index) => index % 2 === 0).slice(0, 4).map((turn) => turn.id), canonicalLarge);
});

test("each question gets its own two-turn short file", () => {
	const files = buildQuestionFiles(SET, { setPath: SET_PATH, outDir: OUT_DIR });
	const shortNames = [...files.keys()].filter((name) => name.startsWith("short/")).sort();
	assert.deepEqual(shortNames, SET.questions.map((question) => `short/${question.id}.json`).sort());
	for (const question of SET.questions) {
		const data = JSON.parse(files.get(`short/${question.id}.json`));
		assert.equal(data.set, SET.id);
		assert.equal(data.commit, SET.repository.commit);
		assert.equal(data.question, question.id);
		assert.equal(data.size, question.size);
		assert.deepEqual(data.turns, [
			{ id: question.id, prompt: question.prompt },
			{ id: `${question.id}-followup`, prompt: question.followup.prompt },
		]);
	}
});

test("every generated cwd is relative and resolves to the pinned worktree", () => {
	const files = buildQuestionFiles(SET, { setPath: SET_PATH, outDir: OUT_DIR });
	for (const [name, content] of files) {
		const { cwd } = JSON.parse(content);
		assert.ok(!cwd.startsWith("/"), `${name}: cwd must be relative, got ${cwd}`);
		assert.equal(resolve(dirname(join(OUT_DIR, name)), cwd), WORKTREE, name);
	}
	// The pinned worktree is a sibling of this repository: <parent>/gentle-shell-worktrees/bench-cc36bd8d.
	assert.equal(WORKTREE, resolve(ROOT, "..", "gentle-shell-worktrees", "bench-cc36bd8d"));
});

test("the build is deterministic and the committed generated files are current", async () => {
	const first = buildQuestionFiles(SET, { setPath: SET_PATH, outDir: OUT_DIR });
	const second = buildQuestionFiles(clone(SET), { setPath: SET_PATH, outDir: OUT_DIR });
	assert.deepEqual([...first.entries()], [...second.entries()]);
	for (const [name, content] of first) {
		assert.equal(await readFile(join(OUT_DIR, name), "utf8"), content, `${name} is stale; run node scripts/build-question-files.mjs`);
	}
	const committedShort = (await readdir(join(OUT_DIR, "short"))).filter((name) => name.endsWith(".json")).map((name) => `short/${name}`).sort();
	assert.deepEqual(committedShort, [...first.keys()].filter((name) => name.startsWith("short/")).sort());
});

test("writing twice yields identical bytes and removes stale short files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "qfiles-"));
	const setPath = join(dir, "set.json");
	const set = syntheticSet();
	await writeFile(setPath, JSON.stringify(set));
	const outDir = join(dir, "generated");
	await writeQuestionFiles(set, { setPath, outDir });
	const before = await readFile(join(outDir, "long.json"), "utf8");
	await writeFile(join(outDir, "short", "gone.json"), "{}");
	await writeQuestionFiles(set, { setPath, outDir });
	assert.equal(await readFile(join(outDir, "long.json"), "utf8"), before);
	assert.ok(!existsSync(join(outDir, "short", "gone.json")), "stale short file removed");
	assert.equal((await readdir(join(outDir, "short"))).length, 12);
});

test("validation rejects a turn without key facts", () => {
	const set = syntheticSet();
	set.questions[0].key.facts = [];
	expectInvalid(set, /s1-q.*key\.facts must be a non-empty array/);
	const followup = syntheticSet();
	delete followup.questions[5].followup.key;
	expectInvalid(followup, /m2-q.*followup.*key/);
});

test("validation rejects a fact without evidence or with malformed evidence", () => {
	const set = syntheticSet();
	set.questions[2].key.facts[0].evidence = [];
	expectInvalid(set, /s3-q.*fact "f1".*evidence/);
	const malformed = syntheticSet();
	malformed.questions[3].followup.key.facts[0].evidence = ["lib/a.ts"];
	expectInvalid(malformed, /s4-q.*followup.*"lib\/a\.ts".*path:line/);
});

test("validation rejects wrong size counts", () => {
	const set = syntheticSet();
	set.questions[0].size = "medium";
	expectInvalid(set, /size counts.*small: expected 4, got 3.*medium: expected 4, got 5/s);
	const unknown = syntheticSet();
	unknown.questions[0].size = "huge";
	expectInvalid(unknown, /s1-q.*size must be one of small, medium, large/);
});

test("validation rejects prompts that do not end with the English instruction, and duplicate ids", () => {
	const set = syntheticSet();
	set.questions[0].followup.prompt = "Detail?";
	expectInvalid(set, /s1-q.*followup.*Answer in English\./);
	const duplicate = syntheticSet();
	duplicate.questions[1].id = duplicate.questions[0].id;
	expectInvalid(duplicate, /duplicate question id "s1-q"/);
	const facts = syntheticSet();
	facts.questions[0].key.facts.push({ ...facts.questions[0].key.facts[0] });
	expectInvalid(facts, /s1-q.*duplicate fact id "f1"/);
});

test("the CLI regenerates the files and reports what it wrote", async () => {
	const dir = await mkdtemp(join(tmpdir(), "qcli-"));
	const setPath = join(dir, "set.json");
	await writeFile(setPath, JSON.stringify(syntheticSet()));
	const outDir = join(dir, "out");
	const { stdout } = await run(process.execPath, [BUILDER, "--set", setPath, "--out", outDir]);
	assert.match(stdout, /13 files/);
	assert.equal(JSON.parse(await readFile(join(outDir, "long.json"), "utf8")).turns.length, 24);
	await assert.rejects(run(process.execPath, [BUILDER, "--set", join(dir, "missing.json"), "--out", outDir]), /cannot read question set/);
});

test("every generated file loads through the runner's loadQuestions", { skip: HAS_WORKTREE ? false : `worktree absent: ${WORKTREE}` }, async () => {
	const names = ["long.json", ...(await readdir(join(OUT_DIR, "short"))).map((name) => `short/${name}`)];
	assert.equal(names.length, 13);
	for (const name of names) {
		const loaded = await loadQuestions(join(OUT_DIR, name));
		assert.equal(loaded.cwd, WORKTREE, name);
		assert.equal(loaded.turns.length, name === "long.json" ? 24 : 2, name);
	}
});

test("the worktree is pinned to the set commit and every evidence line exists", { skip: HAS_WORKTREE ? false : `worktree absent: ${WORKTREE}` }, () => {
	const head = execFileSync("git", ["-C", WORKTREE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(head, SET.repository.commit);
	const lineCounts = new Map();
	const linesOf = (path) => {
		if (!lineCounts.has(path)) lineCounts.set(path, readFileSync(join(WORKTREE, path), "utf8").split("\n").length);
		return lineCounts.get(path);
	};
	let checked = 0;
	for (const question of SET.questions) {
		for (const key of [question.key, question.followup.key]) {
			for (const claim of [...key.facts, ...(key.forbidden ?? [])]) {
				for (const evidence of claim.evidence ?? []) {
					const [, path, start, end] = evidence.match(/^(.+):(\d+)(?:-(\d+))?$/);
					assert.ok(existsSync(join(WORKTREE, path)), `${question.id}: ${path} exists`);
					const last = Number(end ?? start);
					assert.ok(Number(start) >= 1 && Number(start) <= last && last <= linesOf(path), `${question.id}: ${evidence} within ${path} (${linesOf(path)} lines)`);
					checked += 1;
				}
			}
		}
	}
	assert.ok(checked >= 100, `checked ${checked} evidence references`);
});
