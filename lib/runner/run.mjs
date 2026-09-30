import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeSessions } from "../analyze.mjs";
import { selectProfiles } from "../weights.mjs";
import { armDefinition, buildArms, loadOldRulesMap } from "./arms.mjs";
import { driveSession } from "./driver.mjs";
import { buildHome } from "./home.mjs";
import { describeEnv, formatCommand, launchCommand, launchEnv, loadQuestions, planRuns } from "./plan.mjs";
import { RpcClient } from "./rpc-client.mjs";

export const MANIFEST_SCHEMA_VERSION = 1;

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

/** Refuse a live run early when the NaN key is missing. The value is never read beyond presence. */
export function assertApiKey(env) {
	if (!env.NAN_API_KEY) throw new Error("NAN_API_KEY is not set; export it before a live run (the runner reads the key only from the environment and never from auth.json). Use --dry-run to build and inspect without a model session.");
}

/**
 * Build (or reuse) every arm and build every run home, and compute each run's
 * command. Spawns nothing and never deletes an existing arm root.
 */
export async function prepareBench(spec, { baseEnv = process.env } = {}) {
	const questions = await loadQuestions(spec.questions, spec.cwd);
	const oldRulesMap = spec.oldRulesMap ? await loadOldRulesMap(spec.oldRulesMap) : undefined;
	const built = await buildArms(spec.arms, { source: spec.source, donor: spec.donor, workDir: spec.workDir, oldRulesMap });
	const arms = new Map(built.map((arm) => [arm.name, arm]));
	const runs = [];
	for (const entry of planRuns(spec)) {
		const arm = arms.get(entry.arm);
		const home = await buildHome({ template: spec.templateHome, dest: entry.home, model: entry.model, thinking: spec.thinking, contextFixture: spec.contextFixture, keepPackages: spec.keepPackages });
		const command = launchCommand({ launcher: spec.launcher, home: entry.home, packageRoot: arm.root, model: entry.model, thinking: spec.thinking, sessionDir: home.sessionDir, excludeTools: armDefinition(entry.arm).excludeTools });
		const { env, overrides, unset } = launchEnv({ baseEnv, home: entry.home, runDir: entry.runDir, background: spec.background });
		runs.push({ ...entry, homeInfo: home, command, env, overrides, unset });
	}
	return { questions, arms, runs };
}

function analysisSummary(analysis) {
	const parent = analysis.parents[0];
	return { parentTurns: parent.session.turns, children: parent.children.length, unresolvedTasks: parent.unresolvedTasks.length, tokens: parent.totals.tokens, cost: parent.totals.cost };
}

/** Drive one run and write manifest.json, events.jsonl, stderr.log and analysis.json in its run directory. */
export async function executeRun(run, { spec, questions, arm, baseEnv = process.env, driverOptions = {} }) {
	await mkdir(run.runDir, { recursive: true });
	const startedAt = Date.now();
	const manifest = {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		runId: spec.runId,
		arm: run.arm,
		model: run.model,
		rep: run.rep,
		thinking: spec.thinking ?? null,
		background: spec.background,
		contextFixture: spec.contextFixture,
		questions: { path: questions.path, id: questions.id, turns: questions.turns.length },
		cwd: questions.cwd,
		home: run.home,
		sessionDir: run.homeInfo.sessionDir,
		packageRoot: arm.root,
		armInfo: { key: arm.key, builtAt: arm.builtAt, rules: arm.rules, lean: arm.lean, excludeTools: arm.excludeTools, patches: arm.patches.length, removed: arm.removed, orchestratorBytes: arm.orchestratorBytes, source: arm.source, sourceVersion: arm.sourceVersion, donor: arm.donor },
		command: run.command,
		env: describeEnv(run.overrides, baseEnv),
		unsetEnv: run.unset,
		startedAt: new Date(startedAt).toISOString(),
		status: null,
		sessionFile: null,
		sessionId: null,
		turns: [],
		uiRequests: [],
		errors: [],
	};
	const client = new RpcClient({ command: run.command.command, args: run.command.args, cwd: questions.cwd, env: run.env, logPath: join(run.runDir, "events.jsonl"), stderrPath: join(run.runDir, "stderr.log") });
	try {
		await client.start();
		const driven = await driveSession(client, questions.turns, { deadlineMs: spec.turnDeadlineSec * 1000, background: spec.background, agentHome: run.home, ...driverOptions });
		Object.assign(manifest, { status: driven.status, sessionFile: driven.sessionFile, sessionId: driven.sessionId, turns: driven.turns, uiRequests: driven.uiRequests });
		manifest.errors.push(...driven.errors);
	} catch (error) {
		manifest.status = "error";
		manifest.errors.push({ turnId: null, command: "spawn", error: error.message });
	} finally {
		manifest.exit = (await client.close().catch((error) => ({ error: error.message }))) ?? null;
		manifest.invalidStdoutLines = client.invalidLines;
	}
	const endedAt = Date.now();
	manifest.endedAt = new Date(endedAt).toISOString();
	manifest.durationMs = endedAt - startedAt;
	if (manifest.sessionFile && existsSync(manifest.sessionFile)) {
		try {
			const analysis = await analyzeSessions([manifest.sessionFile], { agentHomes: [run.home], profiles: selectProfiles() });
			await writeJson(join(run.runDir, "analysis.json"), analysis);
			manifest.analysis = { file: "analysis.json", ...analysisSummary(analysis) };
		} catch (error) {
			manifest.errors.push({ turnId: null, command: "analyze", error: error.message });
		}
	} else {
		manifest.errors.push({ turnId: null, command: "analyze", error: `no session file to analyze (${manifest.sessionFile ?? "none reported"})` });
	}
	await writeJson(join(run.runDir, "manifest.json"), manifest);
	return manifest;
}

export function formatPlan(spec, prepared) {
	const lines = [`Arms (${join(spec.workDir, "arms")}):`];
	for (const arm of prepared.arms.values()) {
		const tools = arm.excludeTools.length > 0 ? `exclude ${arm.excludeTools.length} subagent tools` : "all tools";
		lines.push(`  ${arm.name.padEnd(17)} ${(arm.lean ? "lean" : "non-lean").padEnd(9)} rules=${arm.rules.padEnd(10)} patches=${String(arm.patches.length).padEnd(3)} orchestrator=${arm.orchestratorBytes} B  ${tools}  hardlinked=${arm.linkStats.linked} copied=${arm.linkStats.copied}`);
		lines.push(`    ${arm.reused ? "reused" : "built "} ${arm.root}`);
	}
	lines.push("", `Runs (${join(spec.workDir, "runs", spec.runId)}), cwd ${prepared.questions.cwd}:`);
	prepared.runs.forEach((run, index) => {
		lines.push(`  [${index + 1}] ${run.arm} ${run.model} rep ${run.rep}`);
		lines.push(`      home: ${run.home}${run.homeInfo.contextFile ? " (AGENTS.md fixture)" : ""}`);
		lines.push(`      ${formatCommand(run.command, run.overrides)}`);
	});
	lines.push("", `${prepared.runs.length} runs planned (${spec.arms.length} arms x ${spec.models.length} models x ${spec.repetitions} repetitions), ${prepared.questions.turns.length} turns each`);
	return `${lines.join("\n")}\n`;
}

/** Dry run: prepare and print. Live run: also refuse without a key, then execute runs sequentially. */
export async function runBench(spec, { dryRun = false, baseEnv = process.env, write = (text) => process.stdout.write(text), driverOptions } = {}) {
	if (!dryRun) assertApiKey(baseEnv);
	const prepared = await prepareBench(spec, { baseEnv });
	write(formatPlan(spec, prepared));
	if (dryRun) {
		write("dry run: no model session was started\n");
		return { prepared, manifests: [] };
	}
	const manifests = [];
	for (const run of prepared.runs) {
		const manifest = await executeRun(run, { spec, questions: prepared.questions, arm: prepared.arms.get(run.arm), baseEnv, driverOptions });
		manifests.push(manifest);
		write(`${run.arm} ${run.model} rep ${run.rep}: ${manifest.status} (${manifest.turns.length}/${prepared.questions.turns.length} turns, ${(manifest.durationMs / 1000).toFixed(1)} s) -> ${run.runDir}\n`);
	}
	return { prepared, manifests };
}
