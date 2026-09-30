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

- [x] T3 Benchmark runner
  - Route: delegated direct (writer trigger: runner modules, arm builder and tests are 2+ non-trivial files).
  - Acceptance: builds isolated homes and per-arm package copies under a gitignored work directory; drives a multi-turn RPC session per arm and repetition from a question file; waits for settle plus child completion with a per-turn deadline; auto-answers or logs UI requests; records session files and per-turn stats; runs the T1 analyzer at the end; dry-run mode that builds everything and prints the plan without calling a model. Also closes the T2 follow-up (`Object.hasOwn` in `selectProfiles`).
  - Checks: `node --test` with a fake RPC pi; dry run over all arms. No live model call without explicit user approval.
  - Done: `run-bench.mjs` plus `lib/runner/` (`jsonl`, `rpc-client`, `driver`, `arms`, `home`, `plan`, `run`); versioned arm inputs under `arms/` (`old-rules.json` line map, `rules/inline.md`, `rules/delegate.md`, `fixtures/managed-blocks-AGENTS.md` with placeholder bodies); README section "Benchmark runner"; `.bench/` gitignored.
  - Arms: package files copied, `node_modules` hardlinked to the release (except `node_modules/.cache`, created empty because jiti writes there), patched files written as new inodes. `old-rules` applies 15 line replacements (4 in `orchestrator.md`, 11 in `orchestrator-delegation.md`, all #1590 lines; the unrelated delivery-menu change stays as shipped); against the real release, patched `orchestrator.md` is byte-identical to the `289cee5b` one. `inline` and `delegate` replace the Mandatory Delegation Triggers block (through rule 5); `inline` adds `--exclude-tools` for `subagent_list_agents,subagent_run,subagent_status,subagent_result,subagent_list_tasks,subagent_reply,subagent_cancel,subagent_send_message,subagent_continue`. Non-lean arms drop `extensions/child-context.ts` only. The builder enforces the 8 KiB rendered budget (bytes: old-rules 6,950, inline 7,002, shipped 7,377, delegate 7,160).
  - Homes: settings.json keeps only `npm:@gtrabanco/pi-nan-provider` (copied from the template `npm/` install) and adds `-builtin:codemode` (the launcher does this only for homes it owns); `subagents.json` routes all 10 agents to the run model, `history_max_tasks` 1,000,000; credentials are never read or copied (test with decoy `auth.json`).
  - Driver: LF-only framing with StringDecoder; turn ends on `agent_settled` with no pending task (event stream plus task records) and a quiet window (1 s, 5 s with background on) measured from the later of settle and last task finish; `handled` disposition does not wait; dialog UI requests answered `cancelled: true`; deadline sends `abort` and ends the run.
  - Finding: task records are written only when a task finishes (`extensions/gentle-agents.ts:569-575`), so queued/running tasks are tracked from `details.gentleAgents` in the event stream, and the records only confirm completion.
  - Test-first evidence:
    - RED: `node --test` 40 tests, 31 pass, 9 fail (4 runner modules missing, 4 CLI tests, `--profile toString` accepted).
    - GREEN: 62 pass, 0 fail.
    - Second cycle: the first real dry run failed with EEXIST because the watch `current` path is a symlink and `fs.cp` copied the link itself; no file in the release changed (`fd --changed-within` count 0). RED test "a source given through a symlink ... is copied as a real tree" failed with the same EEXIST; fix resolves real paths and refuses a copy that is not a real directory. GREEN 63 pass, 0 fail.
  - Verification:
    - `node --test`: 63 tests, 63 pass, 0 fail (about 3 s).
    - `env -u NAN_API_KEY node run-bench.mjs --dry-run --arms all --questions tests/fixtures/questions.example.json --run-id dryrun-verify`: exit 0 in 5.3 s; 6 arms built (23,922 hardlinks each, 0 copies), 6 homes, commands printed, "dry run: no model session was started".
    - `old-rules` arm: `assets/orchestrator.md:54` is `1. **4-file rule** ...`, `:57` is `4. **Long-session rule** ...`; `shipped-nonlean/extensions` has `child-safety.ts` and no `child-context.ts`; release unchanged after the build.
    - Disk: about 44 MB of new data per arm (package copy plus directory entries), homes about 400 KB each.
    - `node $R/bin/gentle-shell.mjs --home <run home> --package-root .bench/arms/shipped --version`: exit 0, `gentle-shell 3.7.0`, `pi 0.99.1`, home path resolved. Limit: `--version` exits at `bin/gentle-shell.mjs:1217`, before the package-root check at `:1302` (a missing path also exits 0), so this confirms the argv shape only; package loading is first proven by the pilot.
  - Size: about 2,080 authored changed lines (runner about 800, tests and fake pi about 750, arm inputs and fixtures, README about 100), above the 400-line heuristic because runner, arms, homes and driver only work together; not split artificially. No remote yet, so no PR slicing applies.
  - Commit: `73c2420` `feat: add benchmark runner for delegation arms`.
  - Parent spot check: `node --test` 63/63; release `cc36bd8d` files `assets/orchestrator.md`, `assets/orchestrator-delegation.md`, `extensions/child-context.ts` byte-identical to the commit.
  - Native review: assessed high (`high_risk`, executable bit on `run-bench.mjs`) against boundary `8811899`; consent granted; four lenses; approved and acknowledged (lineage `review-85a247d11a45f354`). Reviewed boundary is now `73c2420`. Twelve non-blocking findings, tracked as T3.1.
- [x] T3.1 Runner hardening (review follow-ups)
  - Route: delegated direct (bounded writer; fixes plus tests span 2+ non-trivial files).
  - `lib/runner/rpc-client.mjs:99-106` (WARNING, R4 and R3): `close()` sends SIGTERM once and awaits exit with no limit; escalate to SIGKILL or bound the wait.
    - Fixed: the launcher spawns `detached` on POSIX (leader of a new process group that pi joins; the launcher spawns pi without detaching, `bin/gentle-shell.mjs:441`). `close()` is bounded: stdin EOF, wait `graceMs` 10 s; SIGTERM to the group, wait `termGraceMs` 5 s; SIGKILL to the group, wait `killWaitMs` 5 s; then group members that outlived the launcher get SIGTERM/SIGKILL too. Returns `{code, signal, ended: exited|sigterm|sigkill|unresponsive, group: none-left|terminated|killed|survived|not-applicable, waitedMs}` (in the manifest `exit`). A `process` exit hook sends SIGTERM to a live group, and `run-bench.mjs` exits through `process.exit` on SIGINT/SIGTERM so that hook runs (the detached group gets no terminal signal). Subagent children are in pi-owned groups (`lib/agents-runner.ts:464`), so a SIGKILL of pi cannot stop them (documented).
  - `lib/runner/arms.mjs:193-195`, `lib/runner/run.mjs:26` (WARNING, R4 and R3): every invocation, including `--dry-run`, deletes and rebuilds `<workDir>/arms/<name>`, shared across run ids; a concurrent live run loses its package root and old manifests point at rebuilt arms. Scope arms per run id or content hash.
    - Fixed with content keys: roots are `<workDir>/arms/<arm>-<key>`, key = first 12 hex of SHA-256 over builder version, arm, source real path, source fingerprint (content of the 711 package files outside `node_modules`; path, size, mtime of `node_modules` files; symlink targets; `.cache` skipped) and each patched text. Identical inputs reuse the root (`reused`); changed inputs build a new root; nothing deletes a finished root. Builds go to `.bench/arms/.build-*` and are renamed into place when complete (`bench-arm.json` last); a lost race reuses the winner. Manifest `armInfo.key`. Disk: 44 MB per distinct build, shared across run ids; old builds need manual removal (README).
  - `lib/resolve.mjs:59` (WARNING): duplicate or symlinked agent homes make a single session "ambiguous"; de-duplicate by real path.
    - Fixed: candidates de-duplicated by `realpath`, first path kept.
  - `lib/runner/driver.mjs:148`, `:212-213` (WARNING): quiet-window default computed in two places that disagree.
    - Fixed: `resolveDriverOptions` is the only place (explicit `quietMs`, else `backgroundQuietMs` with background on, else `quietMs`).
  - `lib/runner/driver.mjs:45-60` (WARNING): pending-record scan reads task files that, per T3 evidence, are only written on completion.
    - Decision: removed. Evidence (read-only, release `cc36bd8d`): `extensions/gentle-agents.ts:571-575` `persist` is the only writer and is called only from `onFinish` (`:768`), via `lib/agents-history.ts:43` `saveTask` (temp file plus rename). A record can never be pending, so the scan could only be dead or wrong (a stale `running` record held the turn until the deadline). Pending tasks now come from the event stream only; records still confirm completion. Documented in the driver header and README.
  - Suggestions:
    - pi-exits-mid-turn: tested with a new fake-pi `[exit]` scenario (code 3).
    - Template `settings.json` leak: bench settings are built from scratch (`packages`, `extensions: ["-builtin:codemode"]`, `defaultProvider`, `defaultModel`, `defaultThinkingLevel`); theme, TUI state, `lastChangelogVersion` (read only by pi interactive mode) and user extensions stay out.
    - `TEST_LINE_MAP` loads `tests/fixtures/old-rules.test.json`; the real-release test takes `DEFAULTS.source` / `DEFAULTS.donor`.
    - Background turn-end timing guess: not changed; documented as a limitation in README "Turn completion".
  - Test-first evidence:
    - RED (`node --test` on the touched files, new tests first): resolve symlinked home (ambiguous error); arms reuse and new-root tests; CLI dry-run root layout, second-invocation isolation and manifest root; stale running record (turn hit the 1,500 ms deadline); home settings deepEqual (theme and extensions leaked); `close()` orderly/survivor tests (no `ended`/`group`), and the stubborn-group test timed out after 10,000 ms, leaving the fake pi and two SIGTERM-ignoring grandchildren alive (killed by hand).
    - pi-exits-mid-turn passed on unchanged code (coverage gap). Quiet-window refactor and test-map/`DEFAULTS` dedupe are refactors: tests stayed green; a unit test for `resolveDriverOptions` was added and passes.
    - GREEN: `node --test` 72 tests, 72 pass, 0 fail (about 3.5 s); rpc-client tests 3/3 on three consecutive runs; no leftover fake processes.
    - Scratch check: a runner receiving SIGTERM with a child that ignores stdin EOF exits 143 and the child is gone (exit hook).
  - Verification:
    - `node --test`: 72 pass, 0 fail.
    - `env -u NAN_API_KEY node run-bench.mjs --dry-run --arms all --questions tests/fixtures/questions.example.json --run-id t31-a`: exit 0, 5.6 s, six roots `built` (`old-rules-889e6164593c`, `inline-1a35719b8c9b`, `shipped-ac9f65e282c8`, `shipped-nonlean-afd61f53a0aa`, `delegate-f6ee7cc8850c`, `delegate-nonlean-8f930bbffea4`).
    - Same with `--run-id t31-b`: exit 0, 1.0 s, the same six roots `reused`. A snapshot of every root (root inode and mtime, 26,610-26,611 entries, hash over path, inode, size and mtime of every entry) is identical before and after; no `.build-*` left.
    - `old-rules` `assets/orchestrator.md` still byte-identical to the `289cee5b` one; no file under the releases directory changed; `shipped-nonlean/extensions` has no `child-context.ts`.
    - `node analyze-sessions.mjs 01a0f398-30dd-77f4-904c-c5509db04291 --json`: 10 turns, input 42,171, cacheRead 357,696, cacheWrite 0, output 1,056, first 38,336, final 41,922 (cost api 83,220.6, nan 400,923).
  - Size: about 580 insertions and 130 deletions (tests and fake pi about 270), above the 400-line heuristic because the five warnings were fixed together as one review follow-up; not split artificially.
  - Commit: `0377255` `fix: harden benchmark runner shutdown and arm isolation`.
  - Parent spot check: `node --test` 72/72; no lingering fake-pi processes.
  - Native review: assessed medium (`slice_budget_reached`) against boundary `73c2420`; consent granted; reliability lens; approved and acknowledged (lineage `review-6ebd160b68cd6d44`). Reviewed boundary is now `0377255`. Non-blocking findings for later: group liveness probe counts zombie members when PID 1 does not reap (`lib/runner/rpc-client.mjs:184-209`) and the matching test depends on a reaper (`tests/runner-rpc-client.test.mjs:69-76`); a reused arm returns the stored root path instead of the computed one (`lib/runner/arms.mjs:257-258`); the exit hook is dropped when the launcher exits, before `close()` reaps survivors (`lib/runner/rpc-client.mjs:62-63`).
- [x] T3.2 Runtime target: resolved 2026-10-01. "Pi" means the Gentle Shell launcher (as in the reference test session, home `~/.gentle-shell/agent`), which the T3 runner already drives. No change needed.

- [ ] T4 Question set with verified answer keys (small, medium, large; follow-ups), on a pinned repository commit.
- [ ] T5 Pilot run (one model, short sessions) after a quota forecast approved by the user.
- [ ] T6 Full runs (arms x models x repetitions, long sessions beyond 16 turns).
- [ ] T7 Report and post results on #5139.

## Next step

T4 question set, and replace the placeholder bodies in `arms/fixtures/managed-blocks-AGENTS.md` with the real managed content before any `managed-blocks` run; then a quota forecast for T5. Gentle AI #5139 was closed on 2026-09-30 by PR #5147 (evidence budget in the Gentle AI assets); the benchmark measures the shipped rules against the alternatives.
