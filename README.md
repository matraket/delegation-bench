# delegation-bench

An independent replication of the delegation cost study in
[Gentleman-Programming/gentle-ai#5139](https://github.com/Gentleman-Programming/gentle-ai/issues/5139),
run on NaN Builders models through Gentle Shell. #5139 proposed replacing
file-count delegation triggers with an evidence budget and lean subagent
context; Gentle Shell shipped that rule in gentle-shell#1590. This repository
measures, on other model families and under another provider's cache
accounting, whether the shipped rule is followed, what delegating costs in
tokens and quota, what it saves in parent context, and what it does to answer
quality. It contains the harness (runner, cost analyzer, report, blind
grader), the question set with verified answer keys, and the exported results.

## Findings at a glance

Measured on 168 sessions (144 short, 24 long) over three NaN models, with 864
blind-graded answers. Details, tables and caveats: [docs/RESULTS.md](docs/RESULTS.md).

| Finding | Where |
|---|---|
| The shipped evidence-budget rule rarely fires. It delegated in 0, 1 and 1 of 12 short sessions (glm5.3-flash, deepseek-v4-flash, qwen3.8-flash) while the parent exceeded the budget in 9, 12 and 14 of 24 turns. | [Adherence](docs/RESULTS.md#1-rule-adherence) |
| Whether delegation saves tokens depends on how cache reads are priced. In 24-turn sessions, forced delegation cost 0.44x and 0.72x of inline under NaN weights (cache reads count fully), but 1.25x and 1.18x under API weights (cache reads at 0.1). | [Cost](docs/RESULTS.md#2-cost-under-two-weightings) |
| Delegation keeps the parent small: the final parent context was 50% and 35% smaller in long sessions. | [Parent context](docs/RESULTS.md#3-parent-context) |
| Forced delegation loses facts: -0.110 key-fact score versus inline (95% CI -0.145 to -0.076), -0.220 on large questions. The three arms that answered inline are indistinguishable from each other. | [Quality](docs/RESULTS.md#4-answer-quality) |
| Delegation is slower: 1.5x to 2.3x the inline wall time (medians per batch). | [Time](docs/RESULTS.md#5-wall-time) |
| The cost analyzer matches the provider's usage endpoint exactly in 3 of 5 batches and within 0.37% in the other two. | [Measurement check](docs/RESULTS.md#6-measurement-check) |

## Repository map

| Path | What it is |
|---|---|
| [`docs/`](docs/) | Method, reproduction guide, extension guide, results, tool reference. |
| [`results/`](results/README.md) | Exported, privacy-safe results: batch reports, grades, calibration, quality comparison, usage control, provenance. |
| [`questions/`](questions/README.md) | Question set about Gentle Shell `cc36bd8d` with key facts and `path:line` evidence, plus the generated runner files. |
| [`arms/`](arms/) | Inputs that define the experimental arms: old-rules line map, forced rule texts, context fixture. |
| `run-bench.mjs` | Benchmark runner: builds arm packages and isolated homes, drives Gentle Shell over RPC. |
| `analyze-sessions.mjs` | Exact token cost analyzer over pi session JSONL, parent plus delegated children. |
| `report.mjs` | Batch report: cost, delegation, parent context, adherence and reply language per arm. |
| `grade.mjs` | Blind key-fact grader with pluggable judges and calibration tools. |
| `scripts/` | Question file builder and results exporter. |
| `lib/`, `tests/` | Modules and the offline test suite. |
| [`odd/tasks/delegation-benchmark.md`](odd/tasks/delegation-benchmark.md) | Research log: every task, decision and verification, in order. |

## Quick start

Requires Node 24; there are no dependencies.

```bash
npm test                          # offline test suite, no network
node report.mjs --help            # every CLI prints its options with --help
```

Browse [`results/README.md`](results/README.md) for the exported data. A dry
run builds every arm and home and prints the exact launch commands without
starting a model session:

```bash
export DELEGATION_BENCH_SOURCE=<gentle-shell package directory>
export DELEGATION_BENCH_DONOR=<gentle-shell package directory at 289cee5b>
export DELEGATION_BENCH_TEMPLATE_HOME=<agent home with the NaN provider package>
node run-bench.mjs --dry-run --arms all --questions questions/generated/long.json
```

How to obtain those three directories, and every later step up to the
export, is in [docs/REPRODUCE.md](docs/REPRODUCE.md).

## Documentation

| Document | Read it to |
|---|---|
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | Understand what is measured, how and why, and the threats to validity. |
| [docs/RESULTS.md](docs/RESULTS.md) | See every result table with links to the exported data, and what the numbers do and do not show. |
| [docs/REPRODUCE.md](docs/REPRODUCE.md) | Rerun the study step by step, with observed time and quota costs. |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Add a model, provider, arm, question set or judge while keeping results comparable. |
| [docs/TOOLS.md](docs/TOOLS.md) | Look up the CLIs: options, metrics, JSON shapes and file layouts. |

## License

MIT, see [LICENSE](LICENSE). Repository: <https://github.com/matraket/delegation-bench>.
