# Methodology

This study replicates the controlled part of
[gentle-ai#5139](https://github.com/Gentleman-Programming/gentle-ai/issues/5139)
on NaN Builders models through Gentle Shell, with a larger question set,
longer sessions, more repetitions, a stricter grader and a second cost
weighting. This document explains what is measured, how and why. The numbers
are in [RESULTS.md](RESULTS.md); the step-by-step commands are in
[REPRODUCE.md](REPRODUCE.md). Every decision below is recorded, with its
evidence, in the research log
[`odd/tasks/delegation-benchmark.md`](../odd/tasks/delegation-benchmark.md).

## Contents

1. [Research question](#1-research-question)
2. [What is measured](#2-what-is-measured)
3. [Experimental arms](#3-experimental-arms)
4. [Running sessions](#4-running-sessions)
5. [Question set](#5-question-set)
6. [Batches run](#6-batches-run)
7. [Cost measurement](#7-cost-measurement)
8. [Rule adherence](#8-rule-adherence)
9. [Answer grading](#9-answer-grading)
10. [Statistics](#10-statistics)
11. [Limitations and threats to validity](#11-limitations-and-threats-to-validity)

## 1. Research question

#5139 measured what drives the cost of delegation in an agent orchestrator
and proposed a rule. Its cost model:

> cost ≈ tokens the parent absorbs × parent turns that still follow, compared
> with the fixed cost of starting a subagent (its prompt prefix, paid again
> for every delegation).

The proposed rule reads inline only when the evidence fits in one parallel
batch of at most 3 calls and roughly 10k tokens, and delegates one explorer
when the reading is larger, needs more than about 5 sequential lookups, or the
session has a long way to go. #5139 derives it from
`expected tokens × remaining parent turns × 0.1 > per-delegation overhead`,
where 0.1 is the API price of a cache read relative to an uncached input
token. Gentle Shell shipped the rule in gentle-shell#1590 together with lean
child context (children no longer load orchestrator-only instructions).

#5139 used one repository, 8 questions, 2 repetitions and one model family
(claude-bridge Opus). It found that forced delegation cost 46 to 65% more
weighted tokens on targeted questions, that the old file-count rules never
fired, and that all graded answers were correct in every arm (a quality
ceiling).

This replication asks four questions on other model families:

| Question | Why it matters |
|---|---|
| Is the shipped evidence-budget rule followed? | #5139 saw 0 delegations under the old rules; a rule written as prose may not be applied. |
| What does delegation cost when cache reads are not discounted? | On NaN Builders a cache read counts like an uncached input token (section 7). The factor 0.1 in the break-even rule becomes 1, so carrying context in the parent becomes relatively more expensive and delegation should pay off earlier. |
| How much parent context does delegation save in sessions longer than 16 turns? | Carry is what the cost model says delegation saves; long sessions are where it accumulates. |
| Does delegation cost answer quality on questions hard enough to avoid a ceiling? | #5139 could not detect a quality effect because every answer was correct. |

These questions were set before the runs, but no hypothesis or analysis was
pre-registered; the analysis evolved with the pilots (see the research log).

## 2. What is measured

Per session, from the session files and the runner's manifest:

| Measure | Source | Why |
|---|---|---|
| Weighted token cost, parent plus children, under two weightings | Session cost analyzer over the pi session JSONL | The cost side of the model, under API pricing and under NaN quota accounting. |
| Raw tokens (input, cache read, cache write, output) | Same | Lets any other weighting be applied later. |
| Whether the parent delegated, and how many children ran | Analyzer child linkage | Shows whether a rule fired. |
| Peak and final parent context | Analyzer prompt size per turn | The benefit side: what the parent carries. |
| Evidence read and tool rounds per user turn | Parent session | Rule adherence (section 8). |
| Wall time | Runner manifest, per turn | Latency cost of delegation. |
| Reply language | Last answer text per turn | #5139 saw late-session drift to the persona's language. |
| Answer quality | Blind key-fact judge (section 9) | Whether delegation loses information. |

## 3. Experimental arms

Each arm is a copy of the Gentle Shell package with one change.

| Arm | Delegation rules | Child context | Tools | Run |
|---|---|---|---|---|
| `old-rules` | The pre-#1590 file-count rule lines (4-file rule, long-session rule), taken from the release at commit `289cee5b` | lean | all | yes |
| `inline` | Forced inline: [`arms/rules/inline.md`](../arms/rules/inline.md) replaces the Mandatory Delegation Triggers block | lean | the 9 `subagent_*` tools excluded | yes |
| `shipped` | Unchanged: the shipped evidence budget | lean | all | yes |
| `delegate` | Forced delegation: [`arms/rules/delegate.md`](../arms/rules/delegate.md) replaces the trigger block | lean | all | yes |
| `shipped-nonlean` | Unchanged | non-lean (no `extensions/child-context.ts`) | all | built, not run |
| `delegate-nonlean` | Forced delegation | non-lean | all | built, not run |

A context fixture, `managed-blocks`, seeds the run home's `AGENTS.md` with the
gentle-ai managed block markers, to replicate the roughly 37k tokens of managed
instructions that #5139 measured in children. Its block bodies are
placeholders ([`arms/fixtures/managed-blocks-AGENTS.md`](../arms/fixtures/managed-blocks-AGENTS.md)).
Every run used the context fixture `none`: the bench homes have no managed
`AGENTS.md`, so lean and non-lean children would load almost the same context,
and the non-lean arms and the fixture were not run. Lean child context is
therefore not tested here.

The forced rule texts were written for this study (by the author); they are
deliberately strong so that the arm behaves as named. The old-rules arm
applies 15 whole-line replacements from the donor release
([`arms/old-rules.json`](../arms/old-rules.json): 4 in `assets/orchestrator.md`,
11 in `assets/orchestrator-delegation.md`, all lines changed by #1590); the
resulting `assets/orchestrator.md` is byte-identical to the donor's.

### How arms are built

Gentle Shell reads `assets/orchestrator.md` from its package directory and
appends it to the primary session's system prompt only. There is no flag or
environment variable to override it, so rule text cannot be appended from
outside. Each arm is therefore a copy of the package, patched, and selected at
launch with the launcher's `--package-root` flag.

- Package files are real copies; `node_modules` is hardlinked to the source
  package (about 44 MB of new disk per arm), except `node_modules/.cache`,
  which starts empty because the runtime writes there.
- Arm directories are immutable and keyed by a hash of the builder version,
  the arm, the source package's content fingerprint and every patched text, so
  a rebuilt arm with identical inputs is reused and a changed input builds a
  new directory.
- The builder fails if an anchor line or the trigger block is missing, and if
  the rendered `assets/orchestrator.md` exceeds Gentle Shell's 8 KiB budget.

The first live session proved that the arm package is the one loaded: its
system prompt names the arm's assets directory.

## 4. Running sessions

### Isolation

Every arm x model x repetition gets a fresh agent home built from a template:

- `settings.json` is written from scratch: only the NaN provider package
  (`npm:@gtrabanco/pi-nan-provider`, copied from the template's npm install),
  Gentle Shell's own code-mode exclusion, and the run model and thinking
  level. No theme, user extension or other package is carried over.
- `subagents.json` routes every agent to the run model and raises the task
  history limit so that every child can be linked to its parent.
- Credentials are never read or copied; the API key reaches the process only
  through the `NAN_API_KEY` environment variable.
- The launch environment sets `GENTLE_SHELL_HOME`, `GENTLE_SHELL_CONFIG` and
  `GENTLE_PI_CONFIG_HOME` inside the run directory,
  `GENTLE_SHELL_NO_AUTO_SETUP=1`, `DO_NOT_TRACK=1` and
  `GENTLE_PI_BACKGROUND_SUBAGENTS=off`, and removes inherited variables that
  would redirect pi or disable subagents.

Settings common to every run: thinking level `high` for the parent and every
agent, background subagents off, context fixture `none`, a 900 s deadline per
turn, and the default Gentle Shell persona. The bench home's first prompt
prefix was about 17.9k tokens, against 38.3k in the author's everyday Gentle
Shell home, whose extra packages add tools.

### Driving Gentle Shell over RPC

The runner launches Gentle Shell with pi's `--mode rpc` and sends one prompt
per turn over stdin. Print mode was not used because it refuses background
subagents, and RPC exposes the events needed to know when a turn has ended.
A turn ends when `agent_settled` has fired, no subagent task seen in the event
stream is still queued or running, and a quiet window (1 s) passes without a
new run. Dialog requests are answered as cancelled; a turn past its deadline
is aborted and ends the session. At the end, the runner runs the cost
analyzer over the parent session and its children and writes a manifest.

## 5. Question set

12 questions about Gentle Shell, pinned at commit `cc36bd8d` and answered
read-only in a detached worktree of that commit. Full design:
[questions/README.md](../questions/README.md).

| Property | Value |
|---|---|
| Sizes | 4 small (one symbol or file), 4 medium (2 to 4 files or one call chain), 4 large (cross-cutting, roughly 30k+ tokens if read in full) |
| Follow-ups | Each question has one detail follow-up, so there are 24 turns |
| Answer keys | 142 key facts, each with `path:line` evidence in the pinned tree, and 34 forbidden claims (common wrong answers) |
| Leakage control | No question about delegation rules, orchestrator assets or child context, so arm rule text cannot leak answers |
| Language | Every prompt ends with "Answer in English." |
| Short session | One question and its follow-up (2 turns), one session per question |
| Long session | All 24 turns in one session, largest questions first to maximize carry |

## 6. Batches run

| Batch | Model | Sessions | Design | Order | Window (UTC) |
|---|---|---|---|---|---|
| `pilot-01` | `nan/glm5.3-flash` | 48 | 12 short questions x 4 arms x 1 | shuffled, seed `5139` | 2026-10-01 07:26 to 10:30 |
| `pilot-02` deepseek | `nan/deepseek-v4-flash` | 48 | same | same order as pilot-01 | 2026-10-01 11:58 to 13:45 |
| `pilot-02` qwen | `nan/qwen3.8-flash` | 48 | same | same order as pilot-01 | 2026-10-01 13:45 to 18:48 |
| `long-01` | `nan/glm5.3-flash` | 12 | long session x 4 arms x 3 repetitions | shuffled, seed `5139-long` | 2026-10-01 10:42 to 17:25 |
| `long-02` | `nan/deepseek-v4-flash` | 12 | same | same order as long-01 | 2026-10-01 22:00 to 2026-10-02 02:43 |

All 168 sessions completed every turn. The order is
`shuf --random-source=<(yes <seed>)` over the arm x question (or arm x
repetition) pairs; the commands are in [REPRODUCE.md](REPRODUCE.md). Windows
come from [`results/usage-control.json`](../results/usage-control.json).
Batch models were chosen from the models available to the author's NaN plan;
none of them is the judge model.

**Package provenance.** The arms were copied from the Gentle Shell package
that the author's release watcher had installed at run time, not from
`cc36bd8d` (the questions' commit). 150 sessions ran package commit `1162ce90`
(version 3.7.0, pi 0.99.1); 18 ran `2549f17a` (version 3.7.0, pi 0.99.2): the
last 6 qwen pilot sessions (3 old-rules, 3 shipped) and all of long-02. Both
commits have the same rule assets (`assets/orchestrator.md`,
`assets/orchestrator-delegation.md`), child context code and subagent runner
code as `cc36bd8d`; `2549f17a` changes the subagent extension's delivery of
results to an idle parent (gentle-shell#1631). Per-batch counts:
[`results/provenance.md`](../results/provenance.md).

## 7. Cost measurement

### Session cost analyzer

`analyze-sessions.mjs` reads the parent session JSONL and every child session
it delegated to. Children are linked through task records
(`<agentHome>/gentle-agents/tasks/<taskId>.json`), whose ids the parent's
subagent tool results carry; there is no timestamp heuristic. Only assistant
turns with usage count. For each session it sums the four token kinds and
computes the prompt size per turn (`input + cacheRead + cacheWrite`), the
first prefix, the peak and the final context. Definitions:
[TOOLS.md](TOOLS.md#metrics).

### Two weightings

| Profile | input | cache read | cache write | output | Meaning |
|---|---:|---:|---:|---:|---|
| `api` | 1 | 0.1 | 1.25 | 5 | API cache pricing ratios, as in #5139 |
| `nan` | 1 | 1 | 0 | 1 | NaN Builders quota accounting |

Costs are in input-token equivalents, not money.

### Why NaN counts cache reads 1:1

A controlled session on `nan/glm5.3-flash` (10 requests) showed that NaN
reports cache reads but no cache writes, and that its usage counts cache
reads like uncached input. The batches confirm it at scale: NaN's usage
endpoint (`GET /v1/usage`) reports `prompt_tokens` equal to the analyzer's
`input + cacheRead` for the same requests, and that is the number the plan
quota consumes. A cache read therefore costs the quota as much as an
uncached input token, which is what the `nan` profile encodes.

### Matching the provider's usage endpoint

Each batch script read the usage endpoint for the batch model before and
after the batch. The difference is compared with the analyzer's totals in
[`results/usage-control.md`](../results/usage-control.md): exact for prompt
and completion tokens in deepseek-v4-flash pilot, long-01 and long-02; prompt
0.08% lower in pilot-01; prompt 0.31% lower and output 0.37% higher in the
qwen3.8-flash pilot, which had 6 aborted (zero-usage) turns that the analyzer
cannot attribute. A one-session smoke run matched exactly as well.

## 8. Rule adherence

The shipped rule asks the parent to delegate when the evidence it needs does
not fit in one batch of about 10k tokens or needs more than about 5 sequential
lookups. Adherence is measured per user turn from the parent session:

| Quantity | Definition |
|---|---|
| Evidence | Characters of tool-result text the parent received between one user message and the next, divided by 4 |
| Tool rounds | Parent assistant messages with at least one tool call in that turn |
| Turn over budget | Evidence above 10,000 tokens or more than 5 tool rounds |

A turn over budget in the `shipped` arm in which the parent did not delegate
is a turn where the rule says it should have. The measure is a post-hoc proxy:
the parent cannot know the evidence size before reading, and chars/4 only
approximates tokens. The same measure applied to `delegate` parents shows how
little the parent reads when it delegates.

## 9. Answer grading

### Blind key-fact judge

Every user turn's final parent answer (the last non-empty assistant text
before the next user message) is graded against that turn's key. The judge
sees only the question, the answer, the key facts and the forbidden claims;
never the arm, model, run id or costs. For each fact it decides whether the
answer states it (the same claim including specific values, names or
conditions; vague or hedged statements do not count), for each forbidden claim
whether the answer makes it, and the language of the prose. The full prompt is
`SYSTEM_PROMPT` in [`lib/grade/prompt.mjs`](../lib/grade/prompt.mjs) (version
`grade-v1`). Score = supported facts / total facts; "fully correct" = every
fact supported and no forbidden claim.

### Judge choice

The judge was `openai-codex/gpt-6.1-sol`, run through plain `pi -p` with no
tools, extensions, skills, context files or session, on the author's ChatGPT
subscription. It is from a model family that was not benchmarked, it costs no
NaN quota, and running it through bare `pi` keeps any agent prefix out of the
judgment. The grader's default HTTP judge (`nan/mimo-v2.6-flash`) was not used;
a planned comparison between judges was dropped by the author's decision.

### Calibration

Before grading all 864 answers, a seeded blind sample of 30 answers (seed
5139, 18 distinct turns) was graded independently by a Claude model working
from the same sample file, without the judge's verdicts, and then by the
judge. Agreement ([`results/calibration/agreement.md`](../results/calibration/agreement.md)):
156 of 156 fact verdicts (Cohen's kappa 1.0), 46 of 46 forbidden-claim
verdicts, 30 of 30 languages. The reference marked 11 facts as not supported
and no forbidden claim as present, so agreement on negatives rests on 11
cases.

## 10. Statistics

Quality differences between arms are paired: two answers form a pair when
they answer the same turn in the same batch, model and replicate, one from
each arm. For each comparison the study reports the mean score difference
(A minus B), a percentile bootstrap 95% confidence interval of that mean
(5,000 resamples of the pairs, seed 5139, one random stream shared across
comparisons in a fixed order), and how many pairs A lost, won or tied.
Implementation: [`lib/report/quality.mjs`](../lib/report/quality.mjs).

Cost, context and time are reported as medians (and ranges for long
sessions) per arm, without significance tests. Short sessions have one
repetition per question, so differences among the arms that did not delegate
are mostly run-to-run variance (single questions varied up to 8x between arms
in pilot-01).

## 11. Limitations and threats to validity

| Threat | Effect |
|---|---|
| One repository, read-only questions | Results may not transfer to other code bases or to writing tasks, where the shipped rule also routes writes and checks to subagents. |
| Single repetition for short sessions | Per-question cost differences between non-delegating arms are within noise. |
| Forced rule texts written by the author | The `inline` and `delegate` arms show what a strong instruction does, not what the shipped rule would do if followed. |
| Background subagents off | Delegation always waited for the child; background delivery was not tested. |
| Default persona, no managed `AGENTS.md` | Lean versus non-lean child context was not tested; the language drift #5139 linked to a persona setting cannot be compared directly. |
| One judge from one model family | Calibrated on 30 answers with only 11 negative fact verdicts; systematic judge bias on rarer error types cannot be excluded. |
| Answers may reveal delegation | An answer can mention an explorer's findings; the judge is blind to the arm but not to the text. |
| Pairs are not independent | Turns of one long session share context, and the bootstrap resamples pairs, not sessions, so intervals are likely narrower than a session-level analysis would give. |
| Package changed during the study | 18 of 168 sessions ran package `2549f17a` with pi 0.99.2 instead of `1162ce90` with pi 0.99.1 (section 6); in the qwen pilot it affects 3 old-rules and 3 shipped sessions. Rule assets and child context code are identical. |
| Batches overlapped in time | long-01 ran while pilot-02 was running on the same machine and provider; wall times of those batches share load. |
| Children use the parent's model | Child prefix and price are not varied independently of the parent. |
| Extra agent definitions | The template home's `agents/` held the author's own agent definitions next to Gentle Shell's, and every run home copied them, so the parent saw a longer agent list than a fresh install would show. |
| Quota forecasts missed | Observed quota use exceeded the forecasts by up to 3x (qwen pilot) and 2x (long-02); costs per batch are in [REPRODUCE.md](REPRODUCE.md#time-and-quota). |
| Crude language detector in the batch report | It counts common Spanish and English words; the judge's language verdict is the better measure. |
