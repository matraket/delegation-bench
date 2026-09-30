# Delegation benchmark (gentle-ai #5139)

## Objective

Widen the sample behind Gentleman-Programming/gentle-ai#5139 (evidence-budget delegation and lean child context) by running the study on NaN Builders models through Gentle Shell, and report comparable numbers back in the issue.

## Problem

The original study used one repository, 8 questions, 2 repetitions and one model family (claude-bridge Opus). Its cost weights follow API cache pricing (cache read 0.1, cache write 1.25, output 5). On NaN Builders, a controlled test (session `01a0f398-30dd-77f4-904c-c5509db04291`, glm5.3-flash, 10 requests) showed that cache reads count 1:1 toward quota and cache writes are not reported, so the break-even thresholds must be recomputed with other weights.

## Why

Most valuable axes not covered by the original study: other model families (child prefix size), provider cache accounting, session length beyond 16 turns (adherence, raised by Denver2828 in the issue), harder tasks (the original hit a quality ceiling) and more repetitions (language drift signal).

## Scope

- T1: session cost analyzer over pi session JSONL (parent plus delegated children), with configurable weight profiles.
- T2: analyzer hardening from review findings.
- T3-T7: independent replication of the #5139 method (Alan has not shared his harness): runner, question set, pilot, full runs, report. If Alan shares his harness later, T4 questions adapt to it.

### Design (from a read-only exploration of Gentle Shell `cc36bd8d`, 2026-10-01)

- Drive Gentle Shell through `--mode rpc` (print mode refuses background subagents); a turn ends on `agent_settled` with no queued or running child task.
- One fresh isolated home per arm and repetition: `--home`, `GENTLE_SHELL_CONFIG`, `GENTLE_PI_CONFIG_HOME`, `GENTLE_SHELL_NO_AUTO_SETUP=1`, `DO_NOT_TRACK=1`; template with `settings.json` plus the `@gtrabanco/pi-nan-provider` npm install (children only load `settings.json` packages), `agents/`, and `subagents.json` routing every agent to the arm model with `history_max_tasks` raised.
- Arms select a package copy through the launcher's `--package-root`, because `assets/orchestrator.md` is read from the package and appended to the primary session only (no override env or flag):
  - `old-rules`: shipped package with the pre-#1590 file-count rule lines (from release `289cee5b`) patched into its orchestrator assets.
  - `inline`: shipped package with a forced-inline rule, plus `--exclude-tools` for the subagent tools.
  - `shipped`: shipped package unchanged (evidence budget, lean children).
  - `shipped-nonlean`: shipped package without `extensions/child-context.ts` (keeps `child-safety.ts`).
  - `delegate` and `delegate-nonlean`: forced-delegation rule text, with and without lean children.
- Context fixture per run: `none` (this machine has no managed `AGENTS.md`, so lean children change little) or `managed-blocks` (seeded gentle-ai managed blocks to replicate the study's ~37k).
- Cost is measured by the T1 analyzer over the parent and child JSONL, with `api` and `nan` weights.

## Constraints

- Read-only over pi/gentle-shell session data; never modify session files.
- Node 24, no runtime dependencies.
- The analyzer must be exact against the session JSONL; `/nan-usage` is only a coarse control (0.1M precision).

## Delivery strategy

`ask-on-risk` (default). Forecast for T1: ~400 authored changed lines. The repository has no remote, so pull-request slicing does not apply until one exists; work-unit commits stay on `feat/session-cost-analyzer`.

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
  - Commit: `8811899` `feat: add session cost analyzer` on `feat/session-cost-analyzer`.
  - Parent spot check: `node --test` 25/25; reference session re-run matches, cost api 83,220.6 and nan 400,923 recomputed by hand.
  - Native review: assessed medium, `review_due` (`slice_budget_reached`); consent granted; one reliability lens; approved and acknowledged (lineage `review-2bf45063b13545e6`). Four non-blocking findings, tracked as T2.
- [x] T2 Analyzer hardening (review follow-ups)
  - Route: delegated direct (bounded writer; fixes plus tests span 2+ non-trivial files).
  - `lib/weights.mjs:49-54` (WARNING): a custom `--weights` profile named `api` or `nan` silently replaces the built-in one and is still labelled as built-in. Reject or report the collision.
    - Fixed: `parseCustom` rejects a built-in name (`--weights name "api" is reserved for the built-in profile; choose another name`), exit 1. No silent rename.
  - `analyze-sessions.mjs:36`: `--profile ""` yields no profiles and no cost columns without an error.
    - Fixed in `selectProfiles`: an explicit empty list throws `--profile selects no weight profiles; ...`, exit 1 (covers `""` and only commas).
  - `lib/resolve.mjs:29`: session search is in readdir order; sort it so id resolution is deterministic.
    - Fixed: directory entries are sorted by name. Ambiguity rule: an id matching more than one file (any cwd slug, either session dir, any agent home) is an error listing every candidate in deterministic order (homes as given, `sessionDirs` order, then path name); the user passes a path instead. New export `findSessionFilesById`. Documented in README.
  - `lib/children.mjs:94`: the recorded-`sessionPath` branch has no test (fixtures only exercise the basename fallback).
    - Covered: `tests/children.test.mjs` writes a task record whose `sessionPath` exists outside the agent home, plus a same-named decoy under `gentle-agents/sessions`, and asserts `pathResolvedBy: "recorded"` with the recorded path.
  - Test-first evidence:
    - RED: `node --test` 26 tests, 21 pass, 5 fail (2 weights unit tests, 2 CLI tests, `tests/resolve.test.mjs` failing to import `findSessionFilesById`). Behavioral RED for the ambiguity test with a temporary export stub: `Missing expected rejection` (old code silently picked one file). Stub removed.
    - Finding 4 is a coverage gap, so its test passed on the unchanged code; a mutation check (recorded branch disabled) made it fail with the decoy path as actual, then the code was restored.
    - GREEN: `node --test` 31 tests, 31 pass, 0 fail.
  - Verification:
    - `node --test`: 31 pass, 0 fail.
    - `node analyze-sessions.mjs 01a0f398-30dd-77f4-904c-c5509db04291 --json`: 10 turns, input 42,171, cacheRead 357,696, cacheWrite 0, output 1,056, first prefix 38,336, final context 41,922 (unchanged; cost api 83,220.6, nan 400,923).
    - `... --weights '{"name":"api",...}'`: exit 1, `analyze-sessions: --weights name "api" is reserved for the built-in profile; choose another name`.
    - `... --profile ""`: exit 1, `analyze-sessions: --profile selects no weight profiles; name at least one (for example api,nan)`.
    - `node analyze-sessions.mjs 01a0bad5-cbd5-744c-ab32-bb1f41fd0901 --json`: still 9 children, 0 unresolved, no ambiguity on real data.
  - Follow-up (not fixed, out of T2 scope): `selectProfiles` checks names with `in`, so a prototype key such as `--profile toString` is accepted with no weights and reports a `null` cost (observed); `Object.hasOwn` would close it.
  - Commit: `a09c2d4` `fix: harden analyzer profile and session resolution`.
  - Parent spot check: `node --test` 31/31; `--profile ""` exits 1 with the empty-selection error.
  - Native review: assessed medium against the reviewed boundary `8811899`, `review_due` false (`under_budget`); pending in the slice until a later commit reaches the budget.

- [ ] T3 Benchmark runner
  - Route: delegated direct (writer trigger: runner modules, arm builder and tests are 2+ non-trivial files).
  - Acceptance: builds isolated homes and per-arm package copies under a gitignored work directory; drives a multi-turn RPC session per arm and repetition from a question file; waits for settle plus child completion with a per-turn deadline; auto-answers or logs UI requests; records session files and per-turn stats; runs the T1 analyzer at the end; dry-run mode that builds everything and prints the plan without calling a model. Also closes the T2 follow-up (`Object.hasOwn` in `selectProfiles`).
  - Checks: `node --test` with a fake RPC pi; dry run over all arms. No live model call without explicit user approval.
- [ ] T4 Question set with verified answer keys (small, medium, large; follow-ups), on a pinned repository commit.
- [ ] T5 Pilot run (one model, short sessions) after a quota forecast approved by the user.
- [ ] T6 Full runs (arms x models x repetitions, long sessions beyond 16 turns).
- [ ] T7 Report and post results on #5139.

## Next step

T3 by one delegated writer. Gentle AI #5139 was closed on 2026-09-30 by PR #5147 (evidence budget in the Gentle AI assets); the benchmark measures the shipped rules against the alternatives.
