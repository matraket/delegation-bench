#!/usr/bin/env node
// Exact token cost analyzer for pi / Gentle Shell sessions and the subagent
// sessions they delegated to. Read-only over session data.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { analyzeSessions } from "./lib/analyze.mjs";
import { formatTable } from "./lib/format.mjs";
import { defaultAgentHomes } from "./lib/resolve.mjs";
import { selectProfiles } from "./lib/weights.mjs";

const USAGE = `Usage: analyze-sessions.mjs <session-id|session.jsonl>... [options]

Options:
  --json                 Print the machine-readable report (schemaVersion 1)
  --profile <a,b>        Weight profiles to report (default: api,nan[,custom])
  --weights <json>       Custom profile: {"name"?, "input", "cacheRead", "cacheWrite", "output"}
  --agent-home <dir>     Agent home to search (repeatable; default ~/.gentle-shell/agent and ~/.pi/agent)
  -h, --help             Show this help`;

async function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: "boolean", default: false },
			profile: { type: "string" },
			weights: { type: "string" },
			"agent-home": { type: "string", multiple: true },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help || positionals.length === 0) {
		process.stdout.write(`${USAGE}\n`);
		return values.help ? 0 : 1;
	}
	const names = values.profile?.split(",").map((name) => name.trim()).filter(Boolean);
	const profiles = selectProfiles(names, values.weights);
	const agentHomes = values["agent-home"] ?? defaultAgentHomes(homedir());
	const result = await analyzeSessions(positionals, { agentHomes, profiles });
	process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatTable(result));
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error) => {
		process.stderr.write(`analyze-sessions: ${error.message}\n`);
		process.exitCode = 1;
	},
);
