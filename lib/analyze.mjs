import { discoverChildren } from "./children.mjs";
import { resolveSessionArg } from "./resolve.mjs";
import { addTokens, costOf, emptyTokens, readSession, summarizeSession } from "./session-metrics.mjs";

export const SCHEMA_VERSION = 1;

function aggregate(sessions, profiles) {
	const tokens = emptyTokens();
	let turns = 0;
	let zeroUsageTurns = 0;
	for (const session of sessions) {
		addTokens(tokens, session.tokens);
		turns += session.turns;
		zeroUsageTurns += session.zeroUsageTurns;
	}
	return { sessions: sessions.length, turns, zeroUsageTurns, tokens, cost: costOf(tokens, profiles) };
}

/** Full report for one parent session and the children it delegated to. */
export async function analyzeParent(arg, { agentHomes, profiles }) {
	const parent = await readSession(await resolveSessionArg(arg, agentHomes));
	const session = summarizeSession(parent, profiles);
	const discovered = await discoverChildren(parent, agentHomes);
	const children = [];
	for (const child of discovered.children) {
		const metrics = summarizeSession(await readSession(child.path), profiles);
		const agents = [...new Set(child.tasks.map((task) => task.agent).filter(Boolean))];
		children.push({
			...metrics,
			agent: agents.join(",") || null,
			startPrefix: metrics.firstPrefix,
			handoffTokens: child.tasks.reduce((sum, task) => sum + (task.handoff?.tokens ?? 0), 0),
			linkage: { method: "task-record", pathResolvedBy: child.pathResolvedBy },
			tasks: child.tasks,
		});
	}
	const childTotals = aggregate(children, profiles);
	childTotals.handoffTokens = children.reduce((sum, child) => sum + child.handoffTokens, 0);
	return {
		session,
		children,
		unresolvedTasks: discovered.unresolvedTasks,
		totals: { ...aggregate([session, ...children], profiles), children: childTotals },
	};
}

export async function analyzeSessions(args, { agentHomes, profiles }) {
	const parents = [];
	for (const arg of args) parents.push(await analyzeParent(arg, { agentHomes, profiles }));
	return { schemaVersion: SCHEMA_VERSION, profiles, parents };
}
