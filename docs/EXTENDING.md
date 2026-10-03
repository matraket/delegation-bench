# Extending the study

How to add models, providers, arms, question sets and judges, and how to keep
new results comparable with the published ones. Read
[METHODOLOGY.md](METHODOLOGY.md) first for what each part measures, and
[TOOLS.md](TOOLS.md) for the CLI options.

| I want to | Go to |
|---|---|
| Run another NaN model, or another provider | [Add a model or provider](#add-a-model-or-provider) |
| Test a different rule text or package change | [Add an arm](#add-an-arm) |
| Ask questions about another repository | [Add a question set](#add-a-question-set) |
| Grade with another model or service | [Add a judge backend](#add-a-judge-backend) |
| Test lean child context with managed instructions | [Use the context fixture](#use-the-context-fixture) |
| Publish new batches in `results/` | [Export new batches](#export-new-batches) |
| Compare new numbers with the published ones | [Keep results comparable](#keep-results-comparable) |

## Add a model or provider

### Another NaN Builders model

No code change. Pass the model as `<provider>/<model>` and give the batch its
own run-id prefix:

```bash
node run-bench.mjs --questions questions/generated/long.json --arms shipped,delegate --models nan/<model> --run-id long-03-01-shipped-r1
```

The NaN provider package in the template home must list the model; the
provider's `/v1/models` endpoint shows what a key can use. Forecast quota
generously: observed use exceeded forecasts by up to 3x
([REPRODUCE.md](REPRODUCE.md#time-and-quota)). Every agent, children included,
runs on the run model.

### Another provider

The provider must be loadable in a bench home, which is built from scratch:

1. Install the provider's pi package in the template home under `npm/`, and
   list it in a run spec: `{"keepPackages": ["npm:<package>"]}` passed with
   `--spec`. Only `npm:` packages can be kept, and only kept packages are
   loaded.
2. Credentials: bench homes never receive `auth.json` or other credential
   files, so the provider must read its key from an environment variable,
   which the runner passes through to the launcher and its children.
3. Code change: `assertApiKey` in [`lib/runner/run.mjs`](../lib/runner/run.mjs)
   refuses a live run without `NAN_API_KEY`, and the manifest records only that
   variable's presence. Generalize both to the provider's variable before a
   live run.
4. Cost weights: the analyzer accepts custom weights (`--weights`), but the
   batch report reads the `nan` and `api` profiles. To report another
   weighting, add it to `BUILTIN_PROFILES` in [`lib/weights.mjs`](../lib/weights.mjs)
   and to the report's metrics and tables in [`lib/report/`](../lib/report/).
5. Usage control: if the provider has a usage endpoint, log its readings in
   the batch's `progress.log` in the format the export parses
   ([REPRODUCE.md](REPRODUCE.md#4-batches)); otherwise the batch's provider
   columns stay empty.

Check how the provider reports cache tokens first. #5139 found that
claude-bridge reports almost the whole prompt as cache read or cache write,
while NaN reports no cache writes; the right weighting depends on that.

## Add an arm

Arms live in [`lib/runner/arms.mjs`](../lib/runner/arms.mjs): `ARM_NAMES`
(order) and `ARMS` (`rules`, `lean`, `excludeTools`). Each arm becomes a
patched copy of the package, so any change to the files Gentle Shell reads
from its package directory can be an arm.

### A rule-text arm

1. Write the rule text in `arms/rules/<name>.md`. It replaces the block from
   `Mandatory Delegation Triggers` through the line before
   `5. **Verification rule**` in `assets/orchestrator.md`.
2. Add the arm to `ARMS` and `ARM_NAMES`, and extend the branch in `buildArm`
   that applies rule files (today it handles `inline` and `delegate`).
3. If the arm removes tools, list them in `excludeTools`; they are passed to
   pi as `--exclude-tools`.
4. Keep the rendered `assets/orchestrator.md` within the 8 KiB budget; the
   builder refuses a larger one.
5. Add a test next to the existing ones in
   [`tests/runner-arms.test.mjs`](../tests/runner-arms.test.mjs) and check the
   build with a dry run.

### A line-map arm

`old-rules` replaces whole lines of the shipped assets with whole lines of a
donor package ([`arms/old-rules.json`](../arms/old-rules.json): per file, a
list of `{shipped, donor}` line-start anchors, each unique in its file). The
same mechanism can port any other historical rule version: point `--donor` at
a checkout of that version and pass another map with `--old-rules-map`.

### A package-change arm

Non-lean arms delete `extensions/child-context.ts` from the copy (`removed`
in `buildArm`). Other file removals or replacements follow the same pattern.
Bump `ARM_BUILDER_VERSION` whenever the builder's output changes for the same
inputs, so old arm directories are not reused.

### Reporting a new arm

The batch report orders arms as `old-rules`, `inline`, `shipped`, `delegate`,
then any other arm alphabetically ([`lib/report/runs.mjs`](../lib/report/runs.mjs)),
and in short batches computes the "vs inline" ratio for every arm. The quality comparison set is
fixed in `qualityComparisons` ([`lib/report/quality.mjs`](../lib/report/quality.mjs));
append new comparisons at the end so the published intervals keep their
random stream.

## Add a question set

1. Pin the target repository at a commit and answer in a detached worktree of
   it.
2. Write a set file in the format described in
   [questions/README.md](../questions/README.md#set-format): questions with a
   `size`, a prompt ending in "Answer in English.", key facts with
   `path:line` evidence, optional forbidden claims, and one follow-up each.
3. Validate and generate the runner files:

   ```bash
   node scripts/build-question-files.mjs --set questions/<set>.json --out questions/<set>-generated
   ```

   The builder enforces 4 small, 4 medium and 4 large questions; change
   `scripts/build-question-files.mjs` (and its tests) for another shape.
4. Grade with `node grade.mjs --set questions/<set>.json ...`.

Design rules that kept the published keys usable: each fact is atomic and
verifiable in the code, answers are not guessable from file or symbol names,
and no question touches the subject of the arms (delegation rules, orchestrator
assets, child context), so rule text cannot leak answers.

## Add a judge backend

Two backends exist, selected by the `--judge` prefix
([`lib/grade/backends.mjs`](../lib/grade/backends.mjs)):

| Spec | Backend |
|---|---|
| `nan/<model>` | OpenAI-compatible HTTP chat completions (`--judge-url`), key from `NAN_API_KEY` |
| `pi/<provider>/<model>[:thinking]` | One bare `pi -p` process per answer with pi's own login: any model pi can use |

The pi backend already covers most providers. A new backend needs:

1. A prefix in `parseJudgeSpec` and a branch in `createJudge` in
   [`grade.mjs`](../grade.mjs).
2. A factory that returns `judge(messages)`, resolving to
   `{content, usage: {promptTokens, completionTokens}}` and throwing a
   `JudgeError` (retryable or not) on failure; wrap it with `withRetries` from
   [`lib/grade/judge.mjs`](../lib/grade/judge.mjs) so the retry policy and the
   circuit breaker behave like the other backends.
3. Offline tests with a fake server or process, like
   [`tests/grade-pi.test.mjs`](../tests/grade-pi.test.mjs).

Calibrate any new judge on the published blind sample before trusting it:

```bash
node grade.mjs --judge-sample results/calibration/sample.json --judge <spec> --export judge-new.json
node grade.mjs --agreement judge-new.json results/calibration/reference.json
```

Changing the judge prompt requires bumping `PROMPT_VERSION` in
[`lib/grade/prompt.mjs`](../lib/grade/prompt.mjs); it is part of the cache key.

## Use the context fixture

`--context managed-blocks` copies
[`arms/fixtures/managed-blocks-AGENTS.md`](../arms/fixtures/managed-blocks-AGENTS.md)
into each run home as `AGENTS.md`. Its marker lines are real gentle-ai managed
block markers; its bodies are placeholders. Before a live run, replace the
bodies with the real managed content (about 37k tokens in #5139) and keep each
marker alone on its line. Gentle Shell's lean child context removes exactly
the orchestrator-only blocks from children, so with this fixture the
`shipped` versus `shipped-nonlean` and `delegate` versus `delegate-nonlean`
pairs measure lean child context, which the published batches did not test.

## Export new batches

Add one entry per batch to `STUDY_BATCHES` in
[`scripts/export-results.mjs`](../scripts/export-results.mjs):

```js
{ name: "long-03", selector: "long-03-", log: "long-03-logs/progress.log", logModel: "<model>" },
```

`log` is relative to `.bench/`; `logModel` selects the usage lines tagged
with that model (`<utc> <model> usage-before ...`), or `null` for untagged
lines. Change `STUDY_CALIBRATION` for another calibration sample. Then run
`node scripts/export-results.mjs` and commit `results/`.

## Keep results comparable

| Element | Published value | Where it is set |
|---|---|---|
| Question target | Gentle Shell `cc36bd8d` | `questions/gentle-shell-cc36bd8d.set.json` |
| Package under test | `1162ce90` (150 sessions), `2549f17a` (18) | `--source`; recorded per run in the manifest and in [`results/provenance.md`](../results/provenance.md) |
| Donor for old-rules | `289cee5b` | `--donor`, [`arms/old-rules.json`](../arms/old-rules.json) |
| Arm identity | content key per arm build | `.bench/arms/<arm>-<key>`, manifest `armInfo.key` |
| Session order | `shuf --random-source=<(yes 5139)` (short), `yes 5139-long` (long) | batch loops in [REPRODUCE.md](REPRODUCE.md#4-batches) |
| Run settings | thinking `high`, background off, context `none`, 900 s per turn | runner defaults in [`lib/runner/plan.mjs`](../lib/runner/plan.mjs) |
| Calibration sample | 30 answers, seed 5139 | `grade.mjs --sample 30 --seed 5139` |
| Judge | `pi/openai-codex/gpt-6.1-sol`, prompt `grade-v1` | `--judge`, `PROMPT_VERSION` |
| Grade cache key | `cache-v2`: turn id, question prompt, answer, key, judge, prompt version | [`lib/grade/cache.mjs`](../lib/grade/cache.mjs) |
| Bootstrap | 5,000 resamples, seed 5139, fixed comparison order | [`lib/report/quality.mjs`](../lib/report/quality.mjs) |

Practical rules:

- Pin the package. Point `--source` at a fixed checkout, not a directory that
  an updater may change during a batch; the published study mixed two package
  commits because of that.
- Keep run-id conventions: `<batch>-NN-...` for the sequence and `-r<n>` for
  repetitions. Reports and grades derive batches and replicates from them.
- Compare like with like: same model, question file, arms and settings. A new
  model is a new batch, not new rows in an old one.
- Any change to the judge, its prompt or a key regrades the affected answers;
  the cache never mixes judges or prompt versions.
