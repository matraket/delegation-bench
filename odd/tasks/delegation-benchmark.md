# Delegation benchmark (gentle-ai #5139)

## Objective

Widen the sample behind Gentleman-Programming/gentle-ai#5139 (evidence-budget delegation and lean child context) by running the study on NaN Builders models through Gentle Shell, and report comparable numbers back in the issue.

## Problem

The original study used one repository, 8 questions, 2 repetitions and one model family (claude-bridge Opus). Its cost weights follow API cache pricing (cache read 0.1, cache write 1.25, output 5). On NaN Builders, a controlled test (session `01a0f398-30dd-77f4-904c-c5509db04291`, glm5.3-flash, 10 requests) showed that cache reads count 1:1 toward quota and cache writes are not reported, so the break-even thresholds must be recomputed with other weights.

## Why

Most valuable axes not covered by the original study: other model families (child prefix size), provider cache accounting, session length beyond 16 turns (adherence, raised by Denver2828 in the issue), harder tasks (the original hit a quality ceiling) and more repetitions (language drift signal).

## Scope

- T1: session cost analyzer over pi session JSONL (parent plus delegated children), with configurable weight profiles.
- Later tasks (not planned yet): benchmark runner, question set, result report. They depend on whether Alan shares his harness.

## Constraints

- Read-only over pi/gentle-shell session data; never modify session files.
- Node 24, no runtime dependencies.
- The analyzer must be exact against the session JSONL; `/nan-usage` is only a coarse control (0.1M precision).

## Delivery strategy

`ask-on-risk` (default). Forecast for T1: ~400 authored changed lines.

## Tasks

- [x] T1 Session cost analyzer
  - Route: delegated direct (writer trigger: script plus tests are 2+ non-trivial files; preparation trigger: understanding how child sessions link to the parent needs reading gentle-shell sources).
  - Acceptance:
    - Reads one or more parent sessions by path or session id (searching the gentle-shell and pi session directories).
    - Discovers the delegated child sessions of a parent and reports them separately and in totals.
    - Per session: turns, models, raw tokens (input, cacheRead, cacheWrite, output), weighted cost per profile, first-turn prefix, peak and final context.
    - Per child: agent/role, turns, start prefix, peak, raw and weighted cost, handoff size.
    - Weight profiles: `api` (input 1, cacheRead 0.1, cacheWrite 1.25, output 5) and `nan` (input 1, cacheRead 1, cacheWrite 0, output 1), plus custom weights.
    - Human table output and `--json`.
    - Matches session `01a0f398-30dd-77f4-904c-c5509db04291` exactly: 10 turns, input 42,171, cacheRead 357,696, cacheWrite 0, output 1,056, first prefix 38,336, final context 41,922.
  - Checks: `node --test`; analyzer run on the reference session and on one real session with delegations.

## Progress

- 2026-09-30: repository created, branch `feat/session-cost-analyzer`, feature document written.
- 2026-09-30: T1 done (delegated writer). `analyze-sessions.mjs` plus `lib/` (weights, session-metrics, resolve, children, analyze, format), synthetic fixtures and tests under `tests/`, README with metrics, profiles, linkage and JSON shape.
  - Child linkage: parent tool results and pushed `gentle-agents.result` messages carry `details.gentleAgents.taskId`; the task record `<agentHome>/gentle-agents/tasks/<taskId>.json` holds `parentSessionId` and the child `sessionPath`. Child session headers have no parent reference. Limit: task history is pruned to 200 records per agent home; pruned tasks are listed as unresolved, not guessed.
  - Handoff tokens are estimates (`ceil(chars/4)`) of the first finished text the parent received (`subagent_run` / `subagent_result` result or pushed result); `subagent_status` lines are excluded.
  - Test-first: RED observed (9 test files failing, modules missing), GREEN 25/25. A second RED/GREEN cycle fixed a real-data bug (a `subagent_status` "completed" line was taken as the handoff).
  - Evidence:
    - `node --test`: 25 tests, 25 pass, 0 fail.
    - `node analyze-sessions.mjs 01a0f398-30dd-77f4-904c-c5509db04291 --json`: 10 turns, input 42,171, cacheRead 357,696, cacheWrite 0, output 1,056, first prefix 38,336, final context 41,922, nan/glm5.3-flash, 0 zero-usage turns (exact match).
    - `node analyze-sessions.mjs 01a0bad5-cbd5-744c-ab32-bb1f41fd0901`: 9 gentle-ai-worker children (nan/glm5.3-flash), 0 unresolved; child `01a0bb02` cross-checked with jq against the raw file (4 turns, input 35,001, cacheRead 39,680, output 3,702, first 16,971, final 20,426) and matches; handoff 2,023 chars = 506 estimated tokens.
  - Commit: the T1 work-unit commit `feat: add session cost analyzer` on `feat/session-cost-analyzer` (hash reported in the handoff, see `git log`).

## Next step

Decide the benchmark runner and question set (depends on whether Alan shares his harness).
