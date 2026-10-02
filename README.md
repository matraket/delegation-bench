# delegation-bench

Exact, reproducible token cost analyzer for pi / Gentle Shell sessions and the
subagent (child) sessions they delegated to, plus a benchmark runner that
drives Gentle Shell sessions per rule arm (see [Benchmark runner](#benchmark-runner)).
It supports the delegation cost study in Gentleman-Programming/gentle-ai#5139.

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

The search is deterministic (directory entries are sorted by name). Candidates
are de-duplicated by real path, so a repeated or symlinked agent home does not
count one file twice. If an id matches more than one distinct file (for example the same session under two cwd slugs
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

## Benchmark runner

`run-bench.mjs` replicates the #5139 method on Gentle Shell: one multi-turn
RPC session per arm x model x repetition, each in a fresh isolated agent home,
followed by the analyzer over the parent session and its children.

```bash
# Build every arm and home and print the exact commands; no model session.
node run-bench.mjs --dry-run --questions questions.json --arms all

# Live run (needs NAN_API_KEY in the environment; never read from auth.json).
node run-bench.mjs --questions questions.json --arms shipped,delegate --repetitions 3
```

`node run-bench.mjs --help` lists every option. A run spec (`--spec file.json`)
takes the same keys in camelCase (`arms`, `models`, `repetitions`,
`contextFixture`, `background`, `thinking`, `turnDeadlineSec`, `questions`,
`source`, `donor`, `templateHome`, `workDir`, ...); flags override it.

### Question file

```json
{ "id": "set-1", "cwd": "../target-repo", "turns": [
  { "id": "q1", "prompt": "...", "deadlineSec": 600 },
  { "id": "q1-followup", "prompt": "..." }
] }
```

`cwd` (relative to the file, or `--cwd`) is the session working directory.
Turns run in order in one session. `tests/fixtures/questions.example.json` is a
test-only example.

The benchmark question set (12 questions with verified answer keys about
Gentle Shell `cc36bd8d`) lives in [`questions/`](questions/README.md). Its
runner files are generated: `questions/generated/long.json` (24 turns, one
session) and `questions/generated/short/<id>.json` (two turns each), rebuilt
with `node scripts/build-question-files.mjs`.

### Arms

Each arm is a copy of the Gentle Shell release under `.bench/arms/<arm>-<key>`,
selected with the launcher's `--package-root` (the orchestrator rules are read
from the package and appended to the primary session only). Package files are
real copies; `node_modules` is hardlinked to the release (about 44 MB of new
disk per arm instead of 260 MB), except `node_modules/.cache`, which starts empty.

Arm roots are immutable. `<key>` is the first 12 hex characters of a SHA-256
over the builder version, the arm, the source real path, a source fingerprint
(content of every package file outside `node_modules`; path, size and mtime of
every `node_modules` file; symlink targets) and every patched text. An
invocation with identical inputs reuses the existing root (the plan prints
`reused`); any change builds a new root next to it. No invocation, dry run
included, deletes or rewrites a finished root, so a live run and every earlier
manifest keep their package root. A build is assembled in
`.bench/arms/.build-*` and renamed into place only when complete
(`bench-arm.json` is written last); a failed build removes its own temporary
directory. Disk cost is one 44 MB copy per distinct arm build, shared by every
run id; old builds are never collected automatically, so remove
`.bench/arms/<arm>-<key>` by hand once no kept manifest names it as
`packageRoot`. Reused roots keep jiti's `node_modules/.cache` from earlier
runs (a compile cache: it can change start-up time, not the prompt).

| Arm | Rules | Children | Tools |
|-----|-------|----------|-------|
| `old-rules` | pre-#1590 file-count rule lines (`arms/old-rules.json`, from release `289cee5b`) | lean | all |
| `inline` | `arms/rules/inline.md` replaces the Mandatory Delegation Triggers block | lean | `--exclude-tools` for the 9 `subagent_*` tools |
| `shipped` | unchanged | lean | all |
| `shipped-nonlean` | unchanged | non-lean (no `extensions/child-context.ts`) | all |
| `delegate` | `arms/rules/delegate.md` replaces the trigger block | lean | all |
| `delegate-nonlean` | as `delegate` | non-lean | all |

The builder fails if an anchor or the trigger block is missing, and if the
rendered `assets/orchestrator.md` exceeds the 8 KiB orchestrator budget. Every
arm root holds `bench-arm.json` (key, source fingerprint, patches with line
numbers, removed files, bytes); the run manifest records `armInfo.key`.

### Homes

Per run: `.bench/runs/<run-id>/<arm>/<model>/rep-<n>/home`, built from the
template home (default `~/.gentle-shell/agent`). Only `settings.json`,
`npm/package.json`, the kept npm packages (default `npm:@gtrabanco/pi-nan-provider`)
and `agents/*.md` are read; credentials are never read or copied.
`settings.json` is written from scratch with only `packages` (the kept ones),
`extensions: ["-builtin:codemode"]`, `defaultProvider`, `defaultModel` and
`defaultThinkingLevel`; no other template key (theme, TUI state, user
extensions) is carried over;
`subagents.json` routes every agent to the run model with `history_max_tasks`
raised. `--context managed-blocks` seeds `AGENTS.md` from
`arms/fixtures/managed-blocks-AGENTS.md` (placeholder bodies, real markers).

The launch environment adds `GENTLE_SHELL_HOME`, `GENTLE_SHELL_CONFIG`,
`GENTLE_PI_CONFIG_HOME` (all inside the run directory),
`GENTLE_SHELL_NO_AUTO_SETUP=1`, `DO_NOT_TRACK=1` and
`GENTLE_PI_BACKGROUND_SUBAGENTS=on|off`, and removes inherited
`GENTLE_PI_AGENTS*`, `PI_CODING_AGENT_DIR`, `GENTLE_PI_AGENT_HOME` and
`GENTLE_SHELL_PI`.

### Turn completion

The driver frames RPC records on LF only (not `readline`). A turn ends when
`agent_settled` has fired, no subagent task seen in the event stream is still
queued or running, and no new run starts during a quiet window (1 s, or 5 s
with background subagents, whose completions re-trigger the parent). A
`prompt` answered with disposition `handled` does not wait. Dialog UI
requests are answered with `cancelled: true` and recorded. A turn past its
deadline is aborted and ends the run; pi exiting mid-turn ends the run with
status `exited`.

Pending tasks come from `details.gentleAgents` in the event stream only.
Gentle Shell writes `gentle-agents/tasks/<id>.json` once, when a task finishes
(`persist(task)` is called only from the runner's `onFinish` in
`extensions/gentle-agents.ts`), so a record can confirm that a task seen
pending has finished, but a record never announces a pending task; a stale
record that says `running` is ignored.

Limitation: the end of a background turn is a timing guess. No RPC event says
that no more follow-up runs will start, so a background completion that
re-triggers the parent later than the quiet window after the last settle or
task finish is attributed to the next turn. Raise `quietMs` /
`backgroundQuietMs` (driver options) if a pilot shows this.

### Shutdown

On Linux and macOS the launcher starts detached, so it leads a new process
group that pi joins. Closing a run is bounded: close stdin and wait 10 s, then
SIGTERM the group and wait 5 s, then SIGKILL the group and wait 5 s; any group
member that outlived the launcher gets the same SIGTERM/SIGKILL steps. The
manifest's `exit` records `ended` (`exited`, `sigterm`, `sigkill`,
`unresponsive`), `group` (`none-left`, `terminated`, `killed`,
`survived`) and `waitedMs`. Subagent children run in their own process groups
owned by pi, so a SIGKILL of pi cannot stop them; they lose their stdin pipe
with it. If the runner receives SIGINT or SIGTERM it exits through an exit hook
that sends SIGTERM to the launcher group.

### Output per run

- `manifest.json`: arm, model, repetition, home, package root, command,
  environment overrides (the key only as `<set>`), session file, per-turn
  timing, disposition, status, `get_session_stats`, last assistant text,
  background tasks, UI requests, errors, exit, analysis summary.
- `analysis.json`: the analyzer report (`schemaVersion 1`) for the parent
  session, with the run home as the child search root.
- `events.jsonl` (every record in both directions) and `stderr.log`.

The exit code is 0 when every run completed, 2 when any run did not, 1 on errors.

## Batch report

`report.mjs` summarizes completed runs per batch: cost per arm, delegation,
parent context, wall time, evidence-budget adherence and reply language.
Read-only over `.bench/runs`.

```bash
node report.mjs pilot-01-                      # run-id prefix
node report.mjs 'long-0?-*' --out /tmp/reports # glob
node report.mjs pilot-01- long-01- --runs .bench/runs --out .bench/reports
```

Per selector it writes `<out>/<batch>.json` (every per-session row plus the
aggregates) and `<out>/<batch>.md` (the tables), and prints the summary line
and tables. A selector that matches no run is an error (exit 1).

Arm, model, question file and repetition come from each run's
`manifest.json`; directory names are only a fallback. The runner's `rep` is
the repetition inside one run id, so batch repetitions (`long-01-03-inline-r2`)
are read from the `-r<n>` run-id suffix as `replicate`. Short and long
batches are told apart by the question file id (`/short/` or `/long`).

| Metric | Definition |
|--------|------------|
| Cost (`nan`, `api`) | `analysis.json` totals over the parent and its children. |
| Prompt, output, zero-usage turns | Analyzer token totals (`input + cacheRead + cacheWrite`, `output`). |
| Peak, final parent context | Analyzer `peakPrompt` and `finalContext` of the parent. |
| Wall time | Sum of the manifest's per-turn `durationMs`. |
| Evidence per user turn | Parent tool-result text chars / 4 between one user message and the next. |
| Tool rounds per user turn | Parent assistant messages with at least one tool call. |
| Turn over budget | Evidence above 10k tokens or more than 5 tool rounds. |
| Reply language | Last non-empty assistant text of the turn: Spanish when it has more common Spanish words than English ones (crude); late = turn 13 onwards. |

Aggregates are grouped by model, then arm: counts, totals, medians and
min-max over sessions. Short batches add a per-size breakdown and the median
over questions of the per-question NaN cost ratio versus `inline`. The
definitions and numbers match the T5/T6 prototype scripts.

## Answer grader

`grade.mjs` grades every user turn's final parent answer (the last non-empty
assistant text before the next user message) against its key in
`questions/gentle-shell-cc36bd8d.set.json`. Turn ids map to keys as
`<id>` (main question) and `<id>-followup` (its follow-up); turns without a
key are reported and skipped.

- Runs: only runs whose manifest status is `completed` are graded; the
  grader reads the manifest and the parent session, not `analysis.json`.
  Turn ids map to session turns by position, so every mapped turn's sent
  prompt must equal its key's prompt (and the manifest's planned prompt);
  one mismatch skips the whole run as misaligned, so no answer is graded
  against the wrong key. Skipped runs (not completed or misaligned) are
  listed on every run, `--dry-run` included, and in `summary.json`; a live
  run with a misaligned run exits 2.

```bash
env -u NAN_API_KEY node grade.mjs --dry-run pilot-01- pilot-02- long-01- long-02-   # counts and forecast, no API call
NAN_API_KEY=... node grade.mjs pilot-01- pilot-02- long-01- long-02-                # live judging (nan backend)
node grade.mjs --judge pi/openai-codex/gpt-6.1-sol pilot-01-                          # live judging through plain pi
node grade.mjs --sample 30 --seed 5139 --export .bench/grading/calibration-sample.json
node grade.mjs --agreement .bench/grading/grades.jsonl <filled-sample.json>
```

- Blind: the judge sees only the question prompt, the answer, the key facts
  and the forbidden claims, never the arm, model, run id or costs. Run
  metadata is joined after judging.
- Judge backends, selected by the `--judge` prefix (the full spec is the
  judge model name in every record and in the cache key, so judges never
  share cached judgments; any other prefix is refused):
  - `nan/<model>` (default `nan/mimo-v2.6-flash`): OpenAI-compatible chat
    completions at `https://api.nan.builders/v1/chat/completions`
    (`--judge-url`), temperature 0, `response_format` `json_object`
    (`--no-json-mode` to drop it). The key is read only from `NAN_API_KEY`
    (never from auth files) and is never logged; live judging without it
    fails before any call.
  - `pi/<provider>/<model>[:thinking]` (for example
    `pi/openai-codex/gpt-6.1-sol`, a ChatGPT subscription logged in to pi):
    one isolated `pi` process per answer, spawned without a shell, stdin
    closed, with the argument array
    `pi -p --no-session --no-tools --no-extensions --no-skills --no-context-files --system-prompt <judge rules> --model <provider>/<model> --mode json -- <judge input>`.
    No agent prefix, tools, extensions, skills, context files or sessions
    are involved; the same system and user messages as the HTTP backend go
    to `--system-prompt` and the prompt argument. The credential stays inside
    pi: `NAN_API_KEY` is neither needed nor passed to it. The reply and the
    token usage come from the last assistant `message_end` of pi's JSON event
    stream (prompt = input + cache read + cache write, completion = output);
    `--no-json-mode` uses plain text output, where usage is unavailable and
    counted as `unreportedCalls`. When the timeout expires the pi process is
    killed. Failures are classified from the exit code, pi's stderr or the
    stream's error message into a short code: `timeout`, `network`,
    `rate_limited`, `usage_limit` and `server` are retried like HTTP 429/5xx
    and feed the circuit breaker; `auth`, `bad_model`, `pi_not_found` and
    unknown failures (`failed`) are not retried. Only the code is recorded
    (for example `pi judge failed: rate_limited (exit 1); gave up after 5
    attempts`), never pi's stderr. Default concurrency 1.
- Calls: bounded concurrency (`--concurrency`, default 2 for nan, 1 for
  pi), per-call timeout (`--timeout-ms`, default 120 s), retries
  with exponential backoff on 429, 5xx, network errors and timeouts
  (`--max-retries`, default 4; `Retry-After` honored); a body read that
  times out and a truncated or invalid JSON body are retried too. Other HTTP
  errors fail that answer at once. Errors record only the HTTP status and a
  short provider code (for example `judge HTTP 429 (insufficient_quota)
  after 5 attempts`), never the response body, the key or headers.
- Circuit breaker: when `--abort-after` consecutive answers (default 3) fail
  after every retry (sustained 429 quota or 5xx), the batch stops with exit
  1 and does not judge the remaining answers. Judgments already made stay in
  the cache and the previous `grades.jsonl` is left untouched, so a rerun
  resumes where it stopped. Any other judge outcome resets the count; one
  failing worker stops the others from taking new answers.
- Validation: the reply must be one JSON object (a single ```` ```json ````
  fence is tolerated) with every fact id once (`supported: true|false`),
  every forbidden id once (`present: true|false`) and `language`
  `en|es|other`. An invalid reply is asked again once, then recorded as an
  error; the batch continues (exit 2 when any answer has an error).
- Score: supported facts / total facts. Fully correct: every fact supported
  and no forbidden claim. Empty answers are not sent to the judge and score 0.
- Cache: `<out>/cache/`, one file per SHA-256 of (cache key version, turn
  id, question prompt, answer, key, judge model, prompt version), so reruns
  judge only new or changed answers. Identical answers to the same turn share
  one call. Each record's `judge.source` is `judge` (called in this run),
  `cache` (disk hit), `dedupe` (shared another answer's call; a copy of a
  failed call is recorded as failed) or `skipped` (empty answer). Usage
  tokens are recorded only on the answer whose call was made in this run, so
  run totals never replay cached usage.
- `--dry-run`: answers per batch (batch = run id before its `-NN-` sequence
  number), empty, cached and duplicate counts, and estimated judge prompt
  tokens (chars/4) and visible output tokens (reasoning tokens not included).
- `--sample N --seed S --export <file>`: a seeded blind sample (question,
  answer, facts and forbidden claims with empty verdicts; no run, arm or model
  field) for independent grading. The filled file is the reference for
  `--agreement <judge-results> <reference-results>`, which reports per-fact
  agreement (rate and Cohen's kappa), forbidden-claim and language agreement,
  score correlation (Pearson) and mean absolute score difference, with every
  disagreement listed.
- `--judge-sample <sample.json>`: judge the entries of an exported blind
  sample with the selected judge (no runs or question set needed) and write
  the sample with the judge's verdicts filled in (one entry per `sampleId`
  with `facts[].supported`, `forbidden[].present`, `language`, plus
  `source` and a short `error`; schema
  `delegation-bench.sample-judgments/v1`) to `--export <file>`, default
  `<out>/sample-judgments/<judge spec with / as _>.json`. The result is valid
  on either side of `--agreement`. It uses the same cache as full grading
  (same key material), so a sample judged now is not paid for again when the
  same judge grades every answer. `--dry-run` prints the entries to judge
  and the token forecast without starting any judge.

Comparing judges on the same blind answers before grading all 864:

```bash
node grade.mjs pilot-01- pilot-02- long-01- long-02- --sample 30 --seed 5139 --export .bench/grading/calibration-sample.json
node grade.mjs --judge-sample .bench/grading/calibration-sample.json --judge pi/openai-codex/gpt-6.1-sol --dry-run
node grade.mjs --judge-sample .bench/grading/calibration-sample.json --judge pi/openai-codex/gpt-6.1-sol --export .bench/grading/judge-gpt.json
NAN_API_KEY=... node grade.mjs --judge-sample .bench/grading/calibration-sample.json --judge nan/mimo-v2.6-flash --export .bench/grading/judge-mimo.json
# fill a copy of the sample independently (for example a Claude reference) as reference.json, then:
node grade.mjs --agreement .bench/grading/judge-gpt.json .bench/grading/reference.json
node grade.mjs --agreement .bench/grading/judge-mimo.json .bench/grading/reference.json
node grade.mjs --agreement .bench/grading/judge-gpt.json .bench/grading/judge-mimo.json   # judge vs judge
```

Output in `--out` (default `.bench/grading`): `grades.jsonl` (one line per
answer: verdicts, score, usage, then batch, run id, arm, model, replicate,
turn), `summary.json` and `summary.md` (per batch x model x arm: median and
mean score, share fully correct, forbidden claims, languages; Graded counts
answers with a judge verdict, empty answers are counted under Empty and
score 0). Without a selector every run under `--runs` is graded.
`--agreement` accepts JSON (an array or a sample file) or JSONL, including a
JSONL file with a single record.
