import { readFile } from "node:fs/promises";
import { WEIGHT_KEYS, weightedCost } from "./weights.mjs";

/**
 * Read a pi session JSONL file (read-only). Lines that do not parse are
 * skipped and counted so a truncated or corrupted file is visible.
 */
export async function readSession(path) {
	const text = await readFile(path, "utf8");
	const entries = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			malformedLines += 1;
		}
	}
	const header = entries.find((entry) => entry?.type === "session") ?? {};
	return { path, id: header.id ?? null, cwd: header.cwd ?? null, timestamp: header.timestamp ?? null, entries, malformedLines };
}

export function emptyTokens() {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function addTokens(target, source) {
	for (const key of WEIGHT_KEYS) target[key] += source[key];
	return target;
}

export function costOf(tokens, profiles) {
	return Object.fromEntries(Object.entries(profiles).map(([name, weights]) => [name, weightedCost(tokens, weights)]));
}

function count(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Usage of one assistant turn, or undefined when it reported no billed tokens. */
function billedUsage(message) {
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const tokens = { input: count(usage.input), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), output: count(usage.output) };
	return WEIGHT_KEYS.some((key) => tokens[key] > 0) ? tokens : undefined;
}

/**
 * Per-session metrics. Every assistant entry in the file counts, including
 * abandoned branches, because each one was a real provider request.
 * Prompt size of a turn = input + cacheRead + cacheWrite (pi's `input`
 * already excludes cached tokens).
 */
export function summarizeSession(session, profiles) {
	const tokens = emptyTokens();
	const models = new Map();
	const zeroUsageStopReasons = {};
	let turns = 0;
	let zeroUsageTurns = 0;
	let promptTokens = 0;
	let firstPrefix = null;
	let peakPrompt = null;
	let finalContext = null;
	for (const entry of session.entries) {
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		const usage = billedUsage(message);
		if (!usage) {
			zeroUsageTurns += 1;
			const reason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
			zeroUsageStopReasons[reason] = (zeroUsageStopReasons[reason] ?? 0) + 1;
			continue;
		}
		turns += 1;
		addTokens(tokens, usage);
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		promptTokens += prompt;
		firstPrefix ??= prompt;
		peakPrompt = Math.max(peakPrompt ?? 0, prompt);
		finalContext = prompt;
		const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
		models.set(model, (models.get(model) ?? 0) + 1);
	}
	return {
		id: session.id,
		path: session.path,
		cwd: session.cwd,
		startedAt: session.timestamp,
		turns,
		zeroUsageTurns,
		zeroUsageStopReasons,
		models: [...models].map(([model, modelTurns]) => ({ model, turns: modelTurns })),
		tokens,
		promptTokens,
		cost: costOf(tokens, profiles),
		firstPrefix,
		peakPrompt,
		finalContext,
		malformedLines: session.malformedLines,
	};
}
