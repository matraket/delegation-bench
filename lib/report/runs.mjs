// Discover completed benchmark runs under a runs root and read their
// metadata. Layout: <runs>/<run-id>/<arm>/<model-dir>/rep-<n>/manifest.json.
// Metadata comes from the manifest first; directory names are a fallback.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSession } from "../session-metrics.mjs";

export const ARMS = ["old-rules", "inline", "shipped", "delegate"];

const escapeRegExp = (text) => text.replace(/[.+^${}()|\\]/g, "\\$&");

/** A selector is a run-id prefix, or a glob when it contains * ? or [. */
export function matchSelector(selector) {
	if (!/[*?[]/.test(selector)) return (name) => name.startsWith(selector);
	const pattern = selector.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch === "[" || ch === "]" ? ch : escapeRegExp(ch))).join("");
	const regex = new RegExp(`^${pattern}$`);
	return (name) => regex.test(name);
}

async function dirs(path) {
	try {
		return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readQuestionFile(path) {
	if (!path) return null;
	try {
		return await readJson(path);
	} catch {
		return null;
	}
}

const SIZE_BY_PREFIX = { s: "small", m: "medium", l: "large" };

/** Run metadata: manifest fields first, then the question file, then names. */
export async function runMeta(runId, armDir, modelDir, manifest) {
	const questionFile = manifest.questions?.path ?? null;
	const questionSetId = manifest.questions?.id ?? null;
	const file = await readQuestionFile(questionFile);
	const turnCount = manifest.questions?.turns ?? manifest.turns?.length ?? 0;
	const kind = questionSetId?.includes("/short/") ? "short" : questionSetId?.endsWith("/long") ? "long" : turnCount <= 2 ? "short" : "long";
	const question = kind === "short" ? file?.question ?? questionSetId?.split("/").pop() ?? manifest.turns?.[0]?.id ?? null : null;
	const size = kind === "short" ? file?.size ?? SIZE_BY_PREFIX[question?.[0]] ?? null : null;
	const fromName = /-r(\d+)$/.exec(runId);
	return {
		runId: manifest.runId ?? runId,
		arm: manifest.arm ?? armDir,
		model: manifest.model ?? modelDir.replace("_", "/"),
		modelDir,
		rep: manifest.rep ?? null,
		// The runner's `rep` is the repetition inside one run id (always 1 in
		// these batches); batch repetitions are encoded as a `-r<n>` run-id suffix.
		replicate: fromName ? Number(fromName[1]) : manifest.rep ?? 1,
		kind,
		question,
		size,
		questionFile,
		questionSetId,
	};
}

/** Every run (one rep directory with a manifest) whose run id matches the selector. */
export async function discoverRuns(runsRoot, selector) {
	const match = matchSelector(selector);
	const runs = [];
	for (const runId of (await dirs(runsRoot)).filter(match)) {
		for (const arm of await dirs(join(runsRoot, runId))) {
			for (const modelDir of await dirs(join(runsRoot, runId, arm))) {
				for (const rep of (await dirs(join(runsRoot, runId, arm, modelDir))).filter((d) => /^rep-\d+$/.test(d))) {
					const dir = join(runsRoot, runId, arm, modelDir, rep);
					let manifest;
					try {
						manifest = await readJson(join(dir, "manifest.json"));
					} catch (error) {
						if (error.code === "ENOENT") continue;
						throw error;
					}
					runs.push({ dir, manifest, meta: await runMeta(runId, arm, modelDir, manifest) });
				}
			}
		}
	}
	return runs;
}

/** Load the analyzer report and the parent session of a discovered run. */
export async function loadRun(run) {
	const analysis = await readJson(join(run.dir, "analysis.json"));
	const session = await readSession(run.manifest.sessionFile);
	return { ...run, analysis, entries: session.entries };
}
