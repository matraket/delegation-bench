# Reproducing the study

This guide reruns the study from scratch: obtain the inputs, check the
harness offline, run the batches, build the reports, grade the answers and
export the results. Live steps start model sessions and consume provider
quota; the [time and quota table](#time-and-quota) shows what the original
batches used. For what each step measures and why, read
[METHODOLOGY.md](METHODOLOGY.md).

## Quick path

1. [Prerequisites](#1-prerequisites): Node 24, three Gentle Shell checkouts, a template home, a NaN key.
2. [Offline check](#2-offline-check): `npm test` and a dry run.
3. [Smoke run](#3-smoke-run): one two-turn session.
4. [Batches](#4-batches): short and long batches with fixed shuffle seeds.
5. [Reports](#5-reports): one report per batch.
6. [Grading](#6-grading-and-calibration): calibration sample, judge comparison, full grading.
7. [Export](#7-export): `node scripts/export-results.mjs`.

## 1. Prerequisites

| Item | Needed for | How to get it |
|---|---|---|
| Node 24 | everything | Any Node 24 install; the harness has no dependencies. |
| Git, pnpm, `jq`, `curl`, GNU `shuf` | building Gentle Shell, batch scripts | pnpm at the version in Gentle Shell's `packageManager` field (`pnpm@11.1.1` for the measured commits). On macOS GNU `shuf` is `gshuf` (coreutils). |
| Gentle Shell package at the measured commit | every arm (`--source`) | See [Gentle Shell package](#gentle-shell-package). |
| Gentle Shell checkout at `289cee5b` | the `old-rules` arm (`--donor`) | See [Donor checkout](#donor-checkout). |
| Gentle Shell worktree at `cc36bd8d` | the questions' working directory | See [questions/README.md](../questions/README.md#target-repository). |
| Template agent home | every run (`--template-home`) | See [Template home](#template-home). |
| NaN Builders API key | live runs | In the environment as `NAN_API_KEY`; the runner never reads it from a file. Another provider needs the changes in [EXTENDING.md](EXTENDING.md#add-a-model-or-provider). |
| `pi` logged in to a ChatGPT plan (optional) | the judge used in the study | `pi --list-models` must list `openai-codex/gpt-6.1-sol`. Any other judge works, see [EXTENDING.md](EXTENDING.md#add-a-judge-backend). |

Point the runner at the three directories with flags or environment
variables (flag first, then the run spec, then the variable):

```bash
export DELEGATION_BENCH_SOURCE=<path to the Gentle Shell package>      # --source
export DELEGATION_BENCH_DONOR=<path to the 289cee5b checkout>          # --donor
export DELEGATION_BENCH_TEMPLATE_HOME=<path to the template home>      # --template-home
```

A missing one stops the runner with a message that names the flag and the
variable. The donor is required only when `old-rules` is selected.

### Gentle Shell package

The study's arms were copied from Gentle Shell `1162ce90` for 150 sessions and
`2549f17a` for 18 (all of long-02 and the last 6 qwen pilot sessions); both
have the same rule assets and child context code as `cc36bd8d`
([provenance](../results/provenance.md)). Use `1162ce90` to reproduce the
bulk of the study, or `2549f17a` for long-02. A package directory is a
checkout with its dependencies installed:

```bash
git clone https://github.com/Gentleman-Programming/gentle-shell.git
git -C gentle-shell worktree add --detach ../gentle-shell-1162ce90 1162ce9092ba67d342ba83f646b3cb3a7f1c46f7
cd ../gentle-shell-1162ce90 && pnpm install --frozen-lockfile
```

The install runs Gentle Shell's `postinstall`, which installs a package-local
Gentle AI binary. Check the result with
`node bin/gentle-shell.mjs --version` (the measured package printed
`gentle-shell 3.7.0` and `pi 0.99.1`).

### Donor checkout

The `old-rules` arm reads only `assets/orchestrator.md` and
`assets/orchestrator-delegation.md` from the donor, so a plain checkout is
enough:

```bash
git -C gentle-shell worktree add --detach ../gentle-shell-289cee5b 289cee5baad8bafd0d4fb3ea7f28143564edfb84
```

### Template home

The runner builds a fresh home per run from a template and reads only these
template paths:

| Path | Use |
|---|---|
| `settings.json` | Read to fail early on a broken template; nothing is copied from it. |
| `npm/package.json`, `npm/node_modules/@gtrabanco/pi-nan-provider/` | The NaN provider package, copied into every run home. It must already be installed, or pi would try to install it from the network. |
| `agents/*.md` | Agent definitions, copied; every agent is routed to the run model. The package also ships Gentle Shell's own agents under `assets/agents/`. The study's template held Gentle Shell's agents plus the author's own definitions, all of which were visible to the parent. |

Credentials (`auth.json` and similar) are never read. The study used an
existing Gentle Shell home with the provider installed. To prepare a new one,
start Gentle Shell once with `--home <dir>`, add
`"npm:@gtrabanco/pi-nan-provider"` to `<dir>/settings.json` `packages`, and
start it again so that pi installs the package under `<dir>/npm/` (this
follows pi's package install behavior; the study did not exercise it).

## 2. Offline check

```bash
npm test
node run-bench.mjs --dry-run --arms all --questions questions/generated/long.json --run-id dry
```

Expected: the suite passes with no network; the dry run builds six arm
packages under `.bench/arms/<arm>-<key>/` (about 44 MB each on first build,
reused afterwards), one home per run under `.bench/runs/dry/`, prints every
launch command (the key shown as `<from environment>`), and ends with
`dry run: no model session was started`. Remove `.bench/runs/dry` afterwards.

## 3. Smoke run

One session, two turns, to check the provider, the key and the arm loading:

```bash
export NAN_API_KEY=<your key>
node run-bench.mjs --questions questions/generated/short/s1-nan-provider.json --arms shipped --run-id smoke-01
```

Expected: `shipped nan/glm5.3-flash rep 1: completed (2/2 turns, ...)`. The
original smoke run took 101 s and used 125,763 prompt and 2,102 completion
tokens. In `.bench/runs/smoke-01/shipped/nan_glm5.3-flash/rep-1/`:
`manifest.json`, `analysis.json`, `events.jsonl`, `stderr.log`, and the
session under `home/sessions/bench/`.

## 4. Batches

Each batch is a shell loop that runs one session per pair in a fixed shuffled
order and logs the provider's usage before and after. The usage lines are what
the export reads for the [measurement check](RESULTS.md#6-measurement-check);
their format is `<utc> [<model> ]usage-before|usage-after <json>`.

Common helper (save as `.bench/usage.sh` and `source` it; the key is passed
through a process substitution so it does not appear in the process list):

```bash
# usage <model> <first day>: usage of one model summed over the days since the batch started.
usage() {
	curl -s --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$NAN_API_KEY") \
		"https://api.nan.builders/v1/usage?start_date=$2&end_date=$(date -u +%F)&limit=500" |
		jq -c --arg m "$1" '[.data[]? | select(.model==$m) | {date, prompt_tokens, completion_tokens, api_requests}]'
}
```

### Short batches (pilot-01, pilot-02)

12 two-turn questions x 4 arms, shuffled with seed `5139`. pilot-01 used
`glm5.3-flash` with run ids `pilot-01-NN-...`; pilot-02 used the same order on
`deepseek-v4-flash`, then `qwen3.8-flash`, with run ids
`pilot-02-<model>-NN-...`.

```bash
source .bench/usage.sh
OUT=.bench/pilot-02-logs; mkdir -p "$OUT"
pairs=$(for q in questions/generated/short/*.json; do for a in old-rules inline shipped delegate; do echo "$q $a"; done; done |
	shuf --random-source=<(yes 5139))
for model in deepseek-v4-flash qwen3.8-flash; do
	day=$(date -u +%F)
	echo "$(date -u +%FT%TZ) $model usage-before $(usage "$model" "$day")" >> "$OUT/progress.log"
	n=0
	while read -r q a; do
		n=$((n + 1)); id=$(basename "$q" .json)
		run="pilot-02-$model-$(printf '%02d' "$n")-$id-$a"
		node run-bench.mjs --questions "$q" --arms "$a" --models "nan/$model" --run-id "$run" > "$OUT/$run.log" 2>&1
		echo "$(date -u +%FT%TZ) end $model $n/48 $id $a rc=$?" >> "$OUT/progress.log"
	done <<< "$pairs"
	sleep 30
	echo "$(date -u +%FT%TZ) $model usage-after $(usage "$model" "$day")" >> "$OUT/progress.log"
done
```

For pilot-01, use `OUT=.bench/pilot-01-logs`, the single model
`glm5.3-flash` and `run="pilot-01-$(printf '%02d' "$n")-$id-$a"`. The original
pilot-01 and long batches wrote their usage lines without the model tag; the
export accepts both forms (see `logModel` in
[EXTENDING.md](EXTENDING.md#export-new-batches)).

### Long batches (long-01, long-02)

The 24-turn session x 4 arms x 3 repetitions, shuffled with seed `5139-long`.
long-01 used `glm5.3-flash`, long-02 `deepseek-v4-flash`, both in the same
order.

```bash
source .bench/usage.sh
MODEL=glm5.3-flash; PREFIX=long-01; OUT=.bench/$PREFIX-logs; mkdir -p "$OUT"; day=$(date -u +%F)
echo "$(date -u +%FT%TZ) usage-before $(usage "$MODEL" "$day")" >> "$OUT/progress.log"
pairs=$(for r in 1 2 3; do for a in old-rules inline shipped delegate; do echo "$a $r"; done; done | shuf --random-source=<(yes 5139-long))
n=0
while read -r a r; do
	n=$((n + 1))
	run="$PREFIX-$(printf '%02d' "$n")-$a-r$r"
	node run-bench.mjs --questions questions/generated/long.json --arms "$a" --models "nan/$MODEL" --run-id "$run" > "$OUT/$run.log" 2>&1
	echo "$(date -u +%FT%TZ) end $n/12 $a r$r rc=$?" >> "$OUT/progress.log"
done <<< "$pairs"
sleep 30
echo "$(date -u +%FT%TZ) usage-after $(usage "$MODEL" "$day")" >> "$OUT/progress.log"
```

The `-r<n>` suffix of the run id is how reports and grades tell repetitions
apart. Keep the 30 s pause: the usage endpoint lags the last request.

## 5. Reports

```bash
node report.mjs pilot-01- pilot-02-deepseek-v4-flash- pilot-02-qwen3.8-flash- long-01- long-02-
```

Writes `.bench/reports/<batch>.json` and `.md` per selector and prints the
tables. Compare them with [RESULTS.md](RESULTS.md); with new sessions,
costs will differ run to run, so compare rankings and ranges rather than
exact numbers.

## 6. Grading and calibration

```bash
# Counts and a token forecast, no judge call.
node grade.mjs --dry-run --judge pi/openai-codex/gpt-6.1-sol pilot-01- pilot-02- long-01- long-02-

# 1. A seeded blind sample for calibration (no judge call).
node grade.mjs pilot-01- pilot-02- long-01- long-02- --sample 30 --seed 5139 --export .bench/grading/calibration-sample.json

# 2. An independent reference: copy the sample and fill every verdict without
#    seeing any judge output (the study used a Claude model; a person is better).
cp .bench/grading/calibration-sample.json .bench/grading/reference-claude.json   # then fill it

# 3. The judge on the same sample, and the agreement.
node grade.mjs --judge-sample .bench/grading/calibration-sample.json --judge pi/openai-codex/gpt-6.1-sol
node grade.mjs --agreement .bench/grading/sample-judgments/pi_openai-codex_gpt-6.1-sol.json .bench/grading/reference-claude.json

# 4. All answers.
node grade.mjs --judge pi/openai-codex/gpt-6.1-sol pilot-01- pilot-02- long-01- long-02-
```

Outputs in `.bench/grading/`: `grades.jsonl`, `summary.json`, `summary.md`,
`sample-judgments/`, and `cache/` (reruns judge only new or changed answers;
the sample judgments are reused by the full run). The pi judge needs no
`NAN_API_KEY`; the `nan/<model>` judge reads it from the environment. Every
option: [TOOLS.md](TOOLS.md#answer-grader).

## 7. Export

```bash
node scripts/export-results.mjs
```

Writes `results/` (layout in [results/README.md](../results/README.md)) and
ends with `absolute-path scan passed`. It fails, writing nothing, if any
output would contain a path under a home directory. A second run must produce
no `git diff`. New batch names go into `STUDY_BATCHES` in the script
([EXTENDING.md](EXTENDING.md#export-new-batches)).

## Verify cost against the provider

The export's [`usage-control.md`](../results/usage-control.md) compares each
batch's usage delta with the analyzer totals. To check one session by hand:

```bash
RUN=.bench/runs/smoke-01/shipped/nan_glm5.3-flash/rep-1
node analyze-sessions.mjs "$(jq -r .sessionId "$RUN/manifest.json")" --agent-home "$RUN/home" --json
```

The runner already wrote the same report to `$RUN/analysis.json`.

`input + cacheRead + cacheWrite` summed over the parent and its children
should equal the provider's `prompt_tokens` delta for the same window, and
`output` its `completion_tokens` delta, provided nothing else used the same
model and key in that window. Aborted turns without usage in the session file
are the known source of small gaps.

## Time and quota

Observed per batch (provider usage delta from
[`usage-control.json`](../results/usage-control.json), forecasts from the
research log):

| Batch | Sessions | Wall clock | NaN quota used (prompt + completion) | Forecast |
|---|---|---|---|---|
| smoke-01 | 1 | 101 s | 0.13M | |
| pilot-01 (glm5.3-flash) | 48 | 3.1 h | 19.5M | 15 to 25M |
| pilot-02 deepseek-v4-flash | 48 | 1.8 h | 23.5M | |
| pilot-02 qwen3.8-flash | 48 | 5.0 h | 65.6M | 20M |
| long-01 (glm5.3-flash) | 12 | 6.7 h | 96.4M | 40 to 70M |
| long-02 (deepseek-v4-flash) | 12 | 4.7 h | 198.3M | 100M |
| Grading, 864 answers (gpt-6.1-sol via pi) | | about 2.3 h | 1.48M prompt and 0.10M completion tokens on the ChatGPT plan (834 calls) | |
| Calibration sample (30 answers) | | about 10 s per call | | |

Forecasts missed by up to 3x: qwen3.8-flash reads much more per question, and
long sessions on deepseek-v4-flash carried larger parents than expected.
Budget at least twice the forecast for a new model. Disk: about 44 MB per
distinct arm build and about 400 KB per run home, plus the session files.
