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

- [x] T4 Question set with verified answer keys (small, medium, large; follow-ups), on a pinned repository commit.
  - Route: delegated direct (writer trigger: set, builder, tests and docs are 2+ non-trivial files; preparation trigger: verifying keys needs broad reading of Gentle Shell sources).
  - Target: Gentle Shell `cc36bd8d10a4ccb16ad24a84860c4b9ee1a1e8ff`, detached worktree `../gentle-shell-worktrees/bench-cc36bd8d` (sibling of this repository; read-only, no CodeGraph index, explored with `rg`/`bat`).
  - Done: `questions/gentle-shell-cc36bd8d.set.json` (12 questions: 4 small, 4 medium, 4 large, each with one follow-up; 24 turns; every prompt ends with "Answer in English."), `scripts/build-question-files.mjs` (validator plus deterministic builder), generated `questions/generated/long.json` (largest first) and `questions/generated/short/<id>.json` (13 files, committed), `questions/README.md` (method, size classes, key format, regeneration, grading plan), README pointer.
  - Questions: small `s1-nan-provider`, `s2-gauge`, `s3-vim-counts`, `s4-visual-profiles`; medium `m1-resume-hint`, `m2-esc-handling`, `m3-command-palette`, `m4-subscription-usage`; large `l1-launcher-startup`, `l2-prompt-history`, `l3-bash-guard`, `l4-telemetry`. Delegation rules, orchestrator assets, lean child context and tools visible in the model's own schema were avoided.
  - Keys: 142 facts (each with `path:line` evidence) and 34 forbidden claims. Notable non-obvious facts: prompt history ignores the Gentle Shell home (`extensions/history/index.ts:127-133` hard-codes `~/.pi/agent`); the telemetry trigger only honors `DO_NOT_TRACK=1` exactly while runtime metrics treat any truthy value as a veto (`lib/telemetry-trigger.ts:62-67` vs `lib/runtime-metrics-policy.ts:6-11`); `--package-root` forces a take-over only in `--link` mode (`bin/gentle-shell.mjs:1344-1349`).
  - Test-first evidence:
    - RED: `node --test` 73 tests, 72 pass, 1 fail (`tests/question-files.test.mjs`: `ERR_MODULE_NOT_FOUND` for `scripts/build-question-files.mjs`).
    - GREEN: 85 pass, 0 fail (13 new tests: canonical set valid, long ordering, two-turn short files, relative cwd, determinism plus committed files current, rewrite removes stale files, four validation-error tests, CLI, `loadQuestions` over every generated file and evidence/HEAD audit, the last two skip-guarded on the worktree path).
  - Verification:
    - `node --test`: 85 pass, 0 fail.
    - `node scripts/build-question-files.mjs` twice: 13 files each time; `git diff --exit-code -- questions` after the second run: no diff.
    - `env -u NAN_API_KEY node run-bench.mjs --dry-run --arms shipped --questions questions/generated/long.json --run-id t4-dry`: "1 runs planned ..., 24 turns each", cwd the pinned worktree, "dry run: no model session was started"; `.bench/runs/t4-dry` removed afterwards.
    - Evidence audit (6 random facts, 2 per size): `s4-visual-profiles` followup f2 (`lib/visual-profiles.ts:147-153`), `s1-nan-provider` followup f3 (`lib/nan-provider.ts:186-188`), `m1-resume-hint` f8 (`lib/gentle-shell-resume-hint.ts:169-176`), `m2-esc-handling` f5 (`lib/double-esc-cancel-policy.ts:104-106`), `l2-prompt-history` f2 (`lib/history-capture-policy.ts:48-56`), `l1-launcher-startup` f1 (`lib/gentle-shell-launcher.ts:201-215`): all supported by the cited lines.
  - Borderline: `m3-command-palette` follow-up depends on group order beating rank (Visual customization is selected first for "yolo"); `s3-vim-counts` is partly guessable from Vim conventions (the 10000 cap and clamping are not); `l3-bash-guard` and `l4-telemetry` read targeted sections of a 9,869-line file, so actual reading may be closer to 20k tokens than 30k.
  - Size: about 1,340 insertions (set JSON about 420 lines, generated files about 300, builder about 220, tests about 215, docs about 135), above the 400-line heuristic because the key data and its generated copies only work together; not split artificially.
  - Commit: `14fabd0` `feat: add verified question set for gentle-shell cc36bd8d` on `feat/session-cost-analyzer`.
  - Parent spot check: `node --test` 85/85; `s2-gauge` facts f1-f2 checked against `lib/shell-gauge.ts:16-26` in the worktree (8 cells, ▰/▱, thresholds 80/95).
  - Native review: assessed high (heuristic flagged process-spawning text inside the question JSON) against boundary `0377255`; consent granted; four lenses; approved and acknowledged (lineage `review-ea5f2a62829debfc`). Reviewed boundary is now `14fabd0`. Non-blocking findings for later: evidence audit counts one extra line for files ending in a newline (`tests/question-files.test.mjs:198`); the stale-file sweep deletes any `.json` under `<out>/short` before writing (`scripts/build-question-files.mjs:176-177`); generated `<id>-followup` turn ids are not checked for collisions (`:112-114`); generated `cwd` would use backslashes on Windows (`:145`); duplicated size order and evidence regex in tests; README does not say the evidence checks skip without the worktree.
  - Housekeeping 2026-10-01: removed the T3 old-layout arm copies (`.bench/arms/<name>` without key) and `.bench/runs/dryrun-verify` with the user's approval; kept `.bench/arms/shipped-ac9f65e282c8`.
- [x] T5 Pilot run (one model, short sessions) after a quota forecast approved by the user.
  - Pilot `pilot-01` (2026-10-01 07:26-10:30 UTC, user-authorized, forecast 15-25M): 12 short questions x 4 arms (`old-rules`, `inline`, `shipped`, `delegate`), context `none`, `nan/glm5.3-flash`, 1 repetition, 48 sessions shuffled with seed 5139. 48/48 completed, 0 errors. Logs and `summary.json` archived in `.bench/pilot-01-logs/`.
  - Measurement check: NaN usage delta prompt 19,234,669, completion 243,946, 732 requests; analyzer sum prompt 19,219,284 (0.08% lower), output 243,946 (exact).
  - Per arm (12 sessions each; nan weights = raw tokens):

    | Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline (per question) | Final parent context (median) | Wall time (median) |
    |---|---|---|---|---|---|---|---|
    | old-rules | 0 | 0 | 4.84M | 286k | 0.76x | 36.2k | 154 s |
    | inline | 0 | 0 | 6.06M | 297k | 1.00x | 33.2k | 144 s |
    | shipped | 0 | 0 | 3.87M | 234k | 0.85x | 31.4k | 169 s |
    | delegate | 12 | 21 | 4.69M | 330k | 1.03x | 23.9k | 327 s |

  - Reading: `shipped` (evidence budget) never delegated on these short questions, so `old-rules`, `inline` and `shipped` all ran inline and their cost differences reflect run-to-run variance and reading style, not delegation (single questions vary up to 8x between arms, e.g. `s1-nan-provider` 120k to 942k). Forced delegation cost about the same as inline at the median (1.03x; +19% under api weights), kept the parent about 28% smaller, and took about 2.3x the wall time. Child prefixes on NaN are small (about 11-18k), which plausibly explains the much smaller delegation penalty than #5139 reported on claude-bridge (+46-65%).
  - Rule adherence check (parent evidence per user turn, tool-result chars/4, 24 turns per arm): `shipped` exceeded its own budget in 9/24 turns (over 10k tokens read in 7, over 5 sequential tool rounds in 6; up to 32k tokens and 21 rounds in one turn; largest single read 12.8k) and still delegated 0 times. `old-rules` 9/24, `inline` 10/24. `delegate` parents stayed at most 3k tokens and 5 rounds per turn. So `shipped` stayed inline because the model did not follow the rule, not because evidence stayed under budget; this matches #5139's "0 delegations under current rules" and the prose-only enforcement concern in gentle-ai#3411. Script: session scratchpad `budget-check.mjs` (to be moved into the repo with T7).
  - Implications for T6: repetitions are needed (variance dominates single runs); long sessions are where carry, and therefore the rule, should matter; check whether `shipped` stays inline because evidence stays under budget or because the model ignores the rule.
  - Smoke run `smoke-01` (2026-10-01, user-authorized: NaN API, one smoke session, key from `~/.config/delegation-bench/nan.key` via `NAN_API_KEY`): arm `shipped`, `nan/glm5.3-flash`, question `s1-nan-provider` (2 turns). Completed 2/2 turns in 101.2 s, 0 errors, 0 delegations.
    - NaN `GET /v1/usage` delta for the day: prompt 125,763, completion 2,102, 6 requests. Analyzer over the session: 6 turns, input 41,731 + cacheRead 84,032 = 125,763, output 2,102, cacheWrite 0: exact match.
    - The session system prompt contains `Package assets root: .bench/arms/shipped-ac9f65e282c8/assets` and the skill locations under the arm root, so the arm package was loaded (proves the `--package-root` path that `--version` could not).
    - The 28 auto-handled UI requests were `setWidget` (15) and `setStatus` (13), not dialogs.
    - First prefix 17,915 tokens versus 38,336 in the user's own Gentle Shell home (reference session): the bench home loads only the NaN provider package, while the user's home also loads gentle-engram, pi-web-access, pi-btw, pi-mcp-adapter and pi-claude-bridge. Their tools roughly double the parent prefix; worth reporting.
- [ ] T6 Full runs (arms x models x repetitions, long sessions beyond 16 turns).
  - In progress (user-authorized 2026-10-01): `long-01` (glm5.3-flash, `questions/generated/long.json`, 4 arms x 3 repetitions, shuffled, logs `.bench/long-01-logs/`) and `pilot-02` (the T5 short pilot repeated on deepseek-v4-flash, then qwen3.8-flash; same shuffle seed; logs `.bench/pilot-02-logs/`). glm5.3 (premium) is not in the user's plan; models available to the key: deepseek-v4-flash, glm5.3-flash, mimo-v2.6-flash, minimax-h3, qwen3.6, qwen3.8-flash, gemma4.
  - Report script: `.bench/analysis/pilot-report.mjs <run-prefix> <model-dir>` (cost per arm plus evidence-budget adherence; to be moved into the repo with T7).
  - `pilot-02` deepseek-v4-flash (11:58-13:45 UTC): 48/48 completed. NaN usage delta prompt 22,950,932, completion 507,851, 786 requests; analyzer prompt 22,950,932 and output 507,851 (exact).

    | Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline | Final parent context (median) | Wall (median) | Turns over budget |
    |---|---|---|---|---|---|---|---|---|
    | old-rules | 3 | 4 | 6.99M | 410k | 1.72x | 38.2k | 118 s | 10/24 |
    | inline | 0 | 0 | 4.41M | 312k | 1.00x | 37.1k | 83 s | 11/24 |
    | shipped | 1 | 1 | 6.28M | 438k | 1.20x | 45.8k | 101 s | 12/24 |
    | delegate | 12 | 21 | 5.78M | 441k | 1.60x | 26.8k | 165 s | 0/24 |

  - `long-01` glm5.3-flash (10:42-17:25 UTC): 12/12 sessions completed, 288/288 turns settled. NaN usage delta prompt 95,815,510, completion 574,639; analyzer identical (exact). Quota used about 96M, above the 40-70M forecast.

    | Arm | Reps that delegated | Children | NaN median (min-max) | API-weight median | Final parent context (median) | Wall (median) | Turns over budget |
    |---|---|---|---|---|---|---|---|
    | old-rules | 0/3 | 0 | 8.82M (7.88-10.75M) | 1.53M | 156.6k | 27 min | 19/72 |
    | inline | 0/3 | 0 | 9.31M (9.17-10.61M) | 1.51M | 157.8k | 32 min | 16/72 |
    | shipped | 0/3 | 0 | 8.35M (7.27-9.44M) | 1.30M | 152.1k | 28 min | 13/72 |
    | delegate | 3/3 | 61 | 4.13M (3.92-6.75M) | 1.88M | 79.6k | 49 min | 1/72 |

  - Reading (long sessions): under NaN weights (cache reads count 1:1) forced delegation costs about half of any inline arm, with no overlap between ranges across 3 repetitions, and halves the parent context (80k vs 152-158k). Under API weights (cache read 0.1) the same sessions rank the other way: delegation costs about 25-45% more, because carried context is cheap there. The pricing model decides the conclusion. `shipped` still never delegated (0 in 72 turns, 13 over budget). Delegation took about 1.6-1.8x the wall time. No Spanish-reply drift detected in any arm (crude word-count detector; bench homes use the default persona, so this does not replicate #5139's persona setting).
  - `pilot-02` qwen3.8-flash (13:45-18:48 UTC): 48/48 completed, 6 zero-usage turns. NaN usage delta prompt 64,637,039, completion 982,938, 1,720 requests; analyzer prompt 64,436,504 (-0.31%), output 986,557 (+0.37%), the gap is attributed to the 6 aborted turns (not verified). Quota used about 65M, about 3x the 20M forecast (qwen3.8-flash reads much more per question).

    | Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline | Final parent context (median) | Wall (median) | Turns over budget |
    |---|---|---|---|---|---|---|---|---|
    | old-rules | 6 | 8 | 23.53M | 1.45M | 1.28x | 49.9k | 364 s | 17/24 |
    | inline | 0 | 0 | 11.34M | 799k | 1.00x | 54.2k | 267 s | 19/24 |
    | shipped | 1 | 2 | 8.85M | 660k | 0.64x | 48.7k | 238 s | 14/24 |
    | delegate | 12 | 37 | 21.70M | 1.73M | 1.85x | 35.8k | 540 s | 4/24 |

  - Cross-model reading (short pilot, 1 repetition): `shipped` delegated in 0/12 (glm5.3-flash), 1/12 (deepseek-v4-flash), 1/12 (qwen3.8-flash) sessions while exceeding its budget in 9-14 of 24 turns; `old-rules` delegated more on deepseek (3/12) and qwen (6/12). Forced delegation versus inline on short questions: 1.03x, 1.60x, 1.85x.
  - Reading: deepseek-v4-flash also mostly ignores the evidence budget (`shipped` over budget in 12/24 turns, 1 delegation); it delegated more under the old file-count rules (3 sessions). Forced delegation costs more than on glm5.3-flash (1.60x vs 1.03x median) while still shrinking the parent (26.8k vs 37.1k). Single repetition: treat differences among the non-delegating arms as variance.
- [ ] T7 Report and post results on #5139.

## Next step

Replace the placeholder bodies in `arms/fixtures/managed-blocks-AGENTS.md` with the real managed content before any `managed-blocks` run; a grader over the T4 `facts`/`forbidden` keys; then a quota forecast for T5 (short files under `questions/generated/short/`, long file `questions/generated/long.json`). Gentle AI #5139 was closed on 2026-09-30 by PR #5147 (evidence budget in the Gentle AI assets); the benchmark measures the shipped rules against the alternatives.
