# delegation-bench

Exact, reproducible token cost analyzer for pi / Gentle Shell sessions and the
subagent (child) sessions they delegated to. It supports the delegation cost
study in Gentleman-Programming/gentle-ai#5139.

- Node 24, ESM, no dependencies (`node:` builtins only).
- Read-only: it never writes to session files or task records.

## Usage

```bash
node analyze-sessions.mjs <session-id|path/to/session.jsonl>... [options]

node analyze-sessions.mjs 01a0f398-30dd-77f4-904c-c5509db04291
node analyze-sessions.mjs 01a0bad5-cbd5-744c-ab32-bb1f41fd0901 --json
node analyze-sessions.mjs <id> --profile nan
node analyze-sessions.mjs <id> --weights '{"name":"flat","input":1,"cacheRead":1,"cacheWrite":1,"output":1}'
```

| Option | Meaning |
|--------|---------|
| `--json` | Machine-readable report (see [JSON shape](#json-shape)). |
| `--profile a,b` | Weight profiles to report. Default: `api,nan`, plus the custom profile when `--weights` is given. An empty selection (`--profile ""` or only commas) is an error. |
| `--weights <json>` | Custom profile: `{"name"?, "input", "cacheRead", "cacheWrite", "output"}`. All four weights are required; `name` defaults to `custom` and may not be a built-in profile name (`api`, `nan`). |
| `--agent-home <dir>` | Agent home to search (repeatable). Default: `~/.gentle-shell/agent`, then `~/.pi/agent`. |

A session id is resolved by searching, in every agent home,
`sessions/<cwd-slug>/<timestamp>_<id>.jsonl` and
`gentle-agents/sessions/<timestamp>_<id>.jsonl`. Each positional argument is
treated as a parent; its children are discovered automatically.

The search is deterministic (directory entries are sorted by name). If an id
matches more than one file (for example the same session under two cwd slugs
or in both agent homes), the analyzer fails and lists every candidate instead
of picking one; pass the intended file path instead.

Run the tests with `npm test` (`node --test`).

## Metrics

Only assistant turns count (`type == "message"`, `message.role == "assistant"`),
using `message.usage`. pi already reports `input` without cached tokens.

| Metric | Definition |
|--------|------------|
| `turns` | Assistant turns with billed usage (any of the four counts above zero). |
| `zeroUsageTurns` | Assistant turns with zero or missing usage (aborted, errored). Kept out of every other metric; `zeroUsageStopReasons` counts them by `stopReason`. |
| `tokens` | Raw sums of `input`, `cacheRead`, `cacheWrite`, `output` over billed turns. |
| prompt size | Per turn: `input + cacheRead + cacheWrite`. `promptTokens` is the sum. |
| `firstPrefix` | Prompt size of the first billed turn (system prompt, tools and first message). |
| `peakPrompt` | Largest prompt size of any billed turn. |
| `finalContext` | Prompt size of the last billed turn. |
| `cost.<profile>` | `input*w.input + cacheRead*w.cacheRead + cacheWrite*w.cacheWrite + output*w.output`, in input-token equivalents. |
| `models` | `provider/model` with the number of billed turns on it. |
| `malformedLines` | JSONL lines that did not parse and were skipped. |

Every assistant entry in the file counts, including entries on abandoned
branches (`/tree`), because each one was a real provider request.

Per child, additionally:

| Metric | Definition |
|--------|------------|
| `agent` | Agent (role) name from the task record, for example `gentle-ai-explore`. |
| `startPrefix` | Same as the child's `firstPrefix`: what it cost the child to start. |
| `tasks[].handoff` | What the parent received back: `source` (`tool-result`, `pushed-result` or `task-record-result`), `chars`, `tokens`, `tokensMethod`, `deliveries`. |
| `handoffTokens` | Sum of `tasks[].handoff.tokens`. |

Handoff tokens are an **estimate** (`tokensMethod: "estimate:ceil(chars/4)"`):
the parent's usage does not isolate one message, so there is no exact measured
count. `deliveries` counts how many times the finished text reached the parent
(for example a pushed result plus a later `subagent_result` call).

## Weight profiles

| Profile | input | cacheRead | cacheWrite | output | Basis |
|---------|------:|----------:|-----------:|-------:|-------|
| `api` | 1 | 0.1 | 1.25 | 5 | API cache pricing ratios used by the original #5139 study. |
| `nan` | 1 | 1 | 0 | 1 | NaN Builders quota: cache reads count 1:1, cache writes are not reported. |

## Child linkage

Gentle Shell (the `gentle-agents` extension) runs each subagent as a
`pi --mode rpc --session-dir <agentHome>/gentle-agents/sessions` child
(`childArguments` in `lib/agents-runner.ts`). The child's session header holds
no reference to its parent. The explicit link lives in two places:

1. **Parent session**: every `subagent_*` tool result and every pushed
   background completion (`custom_message` with `customType:
   "gentle-agents.result"`) carries `details.gentleAgents.taskId`.
2. **Task record**: when a task finishes, the host writes
   `<agentHome>/gentle-agents/tasks/<taskId>.json` (`lib/agents-history.ts`)
   with `task.parentSessionId` and `task.sessionPath` (the child's session file,
   reported by the child over RPC).

The analyzer takes the task ids referenced by the parent, adds any record whose
`parentSessionId` equals the parent id, and follows each record's `sessionPath`.
If that path no longer exists, it looks for the same file name under
`gentle-agents/sessions` of every agent home (`linkage.pathResolvedBy:
"basename"`). There is no timestamp or content heuristic.

The handoff is the first finished text the parent received: the `subagent_run`
tool result (task mode), a `subagent_result` tool result, or the pushed
`gentle-agents.result` message (background mode). `subagent_status` lines
mention the task but are not a handoff. If the parent never received it, the
task record's `result` is used (`source: "task-record-result"`).

### Limits

- **Task history is pruned** to the newest `history_max_tasks` records per agent
  home (default 200). A pruned task shows up in `unresolvedTasks` with reason
  `no-task-record`; its agent and handoff still come from the parent, but its
  tokens are not in the totals. Analyze runs soon after they finish.
- **Continuations share a child session**: continuing a task starts the child
  with `--session <previous sessionPath>`, so several task ids map to one file.
  They are grouped under one child (`tasks[]`). If a continuation came from a
  different parent session, the shared file is still counted whole.
- **Nested delegation** (a child delegating further) is not followed. None of
  the 228 local task records showed it.
- Other `unresolvedTasks` reasons: `parent-mismatch` (record names another
  parent), `no-session-path`, `session-file-missing`.
- Provider accounting differs: for example, `claude-bridge` reports almost the
  whole prompt as `cacheRead`/`cacheWrite` (about 2 `input` tokens per turn),
  while NaN reports no `cacheWrite`.

## JSON shape

`schemaVersion: 1`. New fields may be added; existing fields keep their meaning.

```text
{
  schemaVersion: 1,
  profiles: { <name>: { input, cacheRead, cacheWrite, output } },
  parents: [{
    session: Session,
    children: [Session & {
      agent, startPrefix, handoffTokens,
      linkage: { method: "task-record", pathResolvedBy: "recorded" | "basename" },
      tasks: [Task]
    }],
    unresolvedTasks: [Task & { reason, recordedSessionPath }],
    totals: Totals & { children: Totals & { handoffTokens } }   // totals = parent + children
  }]
}
Session = { id, path, cwd, startedAt, turns, zeroUsageTurns, zeroUsageStopReasons,
            models: [{ model, turns }], tokens: Tokens, promptTokens,
            cost: { <profile>: number }, firstPrefix, peakPrompt, finalContext, malformedLines }
Task    = { taskId, agent, mode, status, model, referencedInParent,
            handoff: { source, chars, tokens, tokensMethod, deliveries } | null }
Totals  = { sessions, turns, zeroUsageTurns, tokens: Tokens, cost: { <profile>: number } }
Tokens  = { input, cacheRead, cacheWrite, output }
```

`firstPrefix`, `peakPrompt` and `finalContext` are `null` for a session without
billed turns.
