# Results

Results of 168 sessions (5 batches, 3 NaN Builders models, 4 arms) and 864
blind-graded answers. How they were produced: [METHODOLOGY.md](METHODOLOGY.md).
Every table cites the exported file it comes from under
[`results/`](../results/README.md); ratios marked "derived" are computed from
the medians in the cited JSON file.

## Summary

| # | Finding |
|---|---|
| 1 | The shipped evidence-budget rule rarely delegates: 2 of 36 short sessions and 1 of 6 long sessions, while the parent exceeded the budget in 35 of 72 short-session turns and 31 of 144 long-session turns. |
| 2 | Under NaN weights (cache reads count fully) forced delegation halved the cost of a 24-turn session on glm5.3-flash (0.44x) and cut it on deepseek-v4-flash (0.72x). Under API weights (cache reads at 0.1) the same sessions cost more delegated (1.25x and 1.18x). On short sessions delegation cost about the same as inline (glm5.3-flash, 1.03x) or more (1.60x, 1.85x) under NaN weights, and more under API weights. |
| 3 | Delegating parents ended 28 to 50% smaller than inline parents. |
| 4 | Forced delegation covered fewer key facts: -0.110 versus inline (95% CI -0.145 to -0.076), -0.220 on large questions; the three arms that answered inline do not differ detectably. |
| 5 | Delegation took 1.5x to 2.3x the inline wall time. |
| 6 | The analyzer's token totals equal the provider's metered usage exactly in 3 batches and within 0.37% in 2. |

## 1. Rule adherence

A turn is over budget when the parent read more than 10k tokens of tool
results or ran more than 5 tool rounds in it ([definition](METHODOLOGY.md#8-rule-adherence)).

Short sessions (12 per arm and model, 24 turns per arm):

| Model | `shipped`: sessions that delegated | `shipped`: turns over budget | `old-rules`: sessions that delegated | `old-rules`: turns over budget | `inline`: turns over budget | `delegate`: turns over budget |
|---|---|---|---|---|---|---|
| glm5.3-flash | 0 / 12 | 9 / 24 | 0 / 12 | 9 / 24 | 10 / 24 | 0 / 24 |
| deepseek-v4-flash | 1 / 12 | 12 / 24 | 3 / 12 | 10 / 24 | 11 / 24 | 0 / 24 |
| qwen3.8-flash | 1 / 12 | 14 / 24 | 6 / 12 | 17 / 24 | 19 / 24 | 4 / 24 |

Source: [`batches/pilot-01.md`](../results/batches/pilot-01.md),
[`batches/pilot-02-deepseek-v4-flash.md`](../results/batches/pilot-02-deepseek-v4-flash.md),
[`batches/pilot-02-qwen3.8-flash.md`](../results/batches/pilot-02-qwen3.8-flash.md).
The largest evidence a `shipped` parent read in one turn was 32.4k (glm),
36.5k (deepseek) and 32.2k (qwen) tokens.

Long sessions (3 repetitions of 24 turns per arm):

| Model | Arm | Repetitions that delegated | Children | Turns over budget |
|---|---|---|---|---|
| glm5.3-flash | old-rules | 0 / 3 | 0 | 19 / 72 |
| glm5.3-flash | inline | 0 / 3 | 0 | 16 / 72 |
| glm5.3-flash | shipped | 0 / 3 | 0 | 13 / 72 |
| glm5.3-flash | delegate | 3 / 3 | 61 | 1 / 72 |
| deepseek-v4-flash | old-rules | 3 / 3 | 7 | 20 / 72 |
| deepseek-v4-flash | inline | 0 / 3 | 0 | 23 / 72 |
| deepseek-v4-flash | shipped | 1 / 3 | 1 | 18 / 72 |
| deepseek-v4-flash | delegate | 3 / 3 | 49 | 1 / 72 |

Source: [`batches/long-01.md`](../results/batches/long-01.md),
[`batches/long-02.md`](../results/batches/long-02.md).

## 2. Cost under two weightings

NaN weights: input, cache read and output 1, cache write 0. API weights:
input 1, cache read 0.1, cache write 1.25, output 5. Costs are weighted tokens
of the parent plus its children.

Short sessions: "vs inline" is the median over the 12 questions of the
per-question NaN cost ratio to the `inline` arm.

| Model | Arm | NaN total | NaN median | NaN median vs inline | API median |
|---|---|---|---|---|---|
| glm5.3-flash | old-rules | 4.84M | 286k | 0.76x | 97k |
| glm5.3-flash | inline | 6.06M | 297k | 1.00x | 90k |
| glm5.3-flash | shipped | 3.87M | 234k | 0.85x | 73k |
| glm5.3-flash | delegate | 4.69M | 330k | 1.03x | 138k |
| deepseek-v4-flash | old-rules | 6.99M | 410k | 1.72x | 115k |
| deepseek-v4-flash | inline | 4.41M | 312k | 1.00x | 84k |
| deepseek-v4-flash | shipped | 6.28M | 438k | 1.20x | 106k |
| deepseek-v4-flash | delegate | 5.78M | 441k | 1.60x | 178k |
| qwen3.8-flash | old-rules | 23.53M | 1.45M | 1.28x | 312k |
| qwen3.8-flash | inline | 11.34M | 799k | 1.00x | 190k |
| qwen3.8-flash | shipped | 8.85M | 660k | 0.64x | 166k |
| qwen3.8-flash | delegate | 21.70M | 1.73M | 1.85x | 497k |

Source: the three pilot files under [`results/batches/`](../results/batches/).

Long sessions (3 repetitions each):

| Model | Arm | NaN median (min to max) | API median |
|---|---|---|---|
| glm5.3-flash | old-rules | 8.82M (7.88 to 10.75M) | 1.53M |
| glm5.3-flash | inline | 9.31M (9.17 to 10.61M) | 1.51M |
| glm5.3-flash | shipped | 8.35M (7.27 to 9.44M) | 1.30M |
| glm5.3-flash | delegate | 4.13M (3.92 to 6.75M) | 1.88M |
| deepseek-v4-flash | old-rules | 18.19M (16.73 to 20.24M) | 2.85M |
| deepseek-v4-flash | inline | 15.76M (14.99 to 34.87M) | 2.30M |
| deepseek-v4-flash | shipped | 11.94M (11.42 to 18.79M) | 2.00M |
| deepseek-v4-flash | delegate | 11.41M (10.86 to 13.06M) | 2.72M |

Source: [`batches/long-01.md`](../results/batches/long-01.md),
[`batches/long-02.md`](../results/batches/long-02.md).

`delegate` versus `inline`, ratio of medians (derived from
[`batches/long-01.json`](../results/batches/long-01.json) and
[`batches/long-02.json`](../results/batches/long-02.json)):

| Model | NaN weights | API weights |
|---|---|---|
| glm5.3-flash | 0.44x | 1.25x |
| deepseek-v4-flash | 0.72x | 1.18x |

## 3. Parent context

Final parent context (prompt size of the parent's last turn), median per arm:

| Batch | old-rules | inline | shipped | delegate | delegate vs inline (derived) |
|---|---|---|---|---|---|
| pilot-01 (glm5.3-flash, short) | 36.2k | 33.2k | 31.4k | 23.9k | 0.72x |
| pilot-02 (deepseek-v4-flash, short) | 38.2k | 37.1k | 45.8k | 26.8k | 0.72x |
| pilot-02 (qwen3.8-flash, short) | 49.9k | 54.2k | 48.7k | 35.8k | 0.66x |
| long-01 (glm5.3-flash, long) | 156.6k | 157.8k | 152.1k | 79.6k | 0.50x |
| long-02 (deepseek-v4-flash, long) | 254.0k | 263.9k | 246.2k | 170.5k | 0.65x |

Source: [`results/batches/`](../results/batches/) (Markdown tables and JSON
`final.median`).

## 4. Answer quality

Per arm (score = supported key facts / total key facts per answer):

| Batch | Arm | Mean score | Fully correct |
|---|---|---|---|
| pilot-01 | inline / old-rules / shipped / delegate | 0.83 / 0.87 / 0.85 / 0.76 | 50% / 63% / 50% / 42% |
| pilot-02 deepseek-v4-flash | inline / old-rules / shipped / delegate | 0.95 / 0.93 / 0.93 / 0.79 | 71% / 67% / 54% / 50% |
| pilot-02 qwen3.8-flash | inline / old-rules / shipped / delegate | 0.84 / 0.92 / 0.89 / 0.88 | 67% / 67% / 71% / 54% |
| long-01 | inline / old-rules / shipped / delegate | 0.91 / 0.88 / 0.87 / 0.75 | 61% / 58% / 53% / 40% |
| long-02 | inline / old-rules / shipped / delegate | 0.96 / 0.93 / 0.93 / 0.86 | 78% / 74% / 68% / 53% |

Source: [`grading/summary.md`](../results/grading/summary.md). All 864
answers were graded, with 0 judge errors and 0 empty answers.

Paired differences (A minus B over answers to the same turn in the same
batch, model and replicate; bootstrap 95% CI):

| Comparison | Subset | Pairs | Mean difference | 95% CI | A worse / better / tied |
|---|---|---|---|---|---|
| delegate - inline | all | 216 | -0.110 | -0.145 to -0.076 | 89 / 11 / 116 |
| delegate - shipped | all | 216 | -0.089 | -0.120 to -0.052 | 83 / 21 / 112 |
| delegate - old-rules | all | 216 | -0.101 | -0.135 to -0.073 | 84 / 15 / 117 |
| shipped - inline | all | 216 | -0.021 | -0.045 to 0.006 | 54 / 22 / 140 |
| old-rules - inline | all | 216 | -0.008 | -0.032 to 0.013 | 46 / 31 / 139 |
| delegate - inline | small questions | 72 | -0.036 | -0.063 to -0.012 | 14 / 3 / 55 |
| delegate - inline | medium questions | 72 | -0.073 | -0.133 to -0.013 | 28 / 4 / 40 |
| delegate - inline | large questions | 72 | -0.220 | -0.277 to -0.168 | 47 / 4 / 21 |
| delegate - inline | follow-ups | 108 | -0.053 | -0.091 to -0.016 | 25 / 4 / 79 |
| delegate - inline | first questions | 108 | -0.166 | -0.214 to -0.120 | 64 / 7 / 37 |
| delegate - inline | glm5.3-flash | 96 | -0.139 | -0.189 to -0.092 | 43 / 5 / 48 |
| delegate - inline | deepseek-v4-flash | 96 | -0.117 | -0.152 to -0.083 | 40 / 3 / 53 |
| delegate - inline | qwen3.8-flash | 24 | +0.037 | -0.087 to 0.175 | 6 / 3 / 15 |
| delegate - inline | long sessions | 144 | -0.131 | -0.173 to -0.101 | 64 / 6 / 74 |
| delegate - inline | short sessions | 72 | -0.068 | -0.128 to -0.001 | 25 / 5 / 42 |

Source: [`quality.md`](../results/quality.md), [`quality.json`](../results/quality.json).
Judge calibration: [`calibration/agreement.md`](../results/calibration/agreement.md)
(156 of 156 fact verdicts and 46 of 46 forbidden-claim verdicts agree with an
independent reference on 30 answers).

Reply language: the judge classified every answer as English except 22
answers of one long-02 `delegate` session, which were in Spanish despite
"Answer in English." ([`grading/summary.md`](../results/grading/summary.md),
long-02 delegate: en/es 50/22). No other session drifted.

## 5. Wall time

Median session wall time (sum of turn durations):

| Batch | old-rules | inline | shipped | delegate | delegate vs inline (derived) |
|---|---|---|---|---|---|
| pilot-01 | 154 s | 144 s | 169 s | 327 s | 2.27x |
| pilot-02 deepseek-v4-flash | 118 s | 83 s | 101 s | 165 s | 1.98x |
| pilot-02 qwen3.8-flash | 364 s | 267 s | 238 s | 540 s | 2.02x |
| long-01 | 27 min | 32 min | 28 min | 49 min | 1.55x |
| long-02 | 21 min | 19 min | 21 min | 34 min | 1.73x |

Source: [`results/batches/`](../results/batches/) (JSON `wallSeconds.median`).
long-01 overlapped with the pilot-02 batches on the same machine and
provider, so its times share load with them.

## 6. Measurement check

| Batch | Provider prompt tokens | Analyzer prompt tokens | Difference | Provider completion | Analyzer output | Difference |
|---|---|---|---|---|---|---|
| pilot-01 | 19,234,669 | 19,219,284 | -0.08% | 243,946 | 243,946 | 0 |
| pilot-02 deepseek-v4-flash | 22,950,932 | 22,950,932 | 0 | 507,851 | 507,851 | 0 |
| pilot-02 qwen3.8-flash | 64,637,039 | 64,436,504 | -0.31% | 982,938 | 986,557 | +0.37% |
| long-01 | 95,815,510 | 95,815,510 | 0 | 574,639 | 574,639 | 0 |
| long-02 | 196,730,717 | 196,730,717 | 0 | 1,529,243 | 1,529,243 | 0 |

Source: [`usage-control.md`](../results/usage-control.md). The qwen batch had
6 aborted turns with no usage in the session files; the gap is attributed to
them, which is not verified.

## Interpretation

### Measured facts

- Under the shipped rule the parent exceeded the budget in 9 to 14 of 24
  short-session turns per model and in 13 and 18 of 72 long-session turns, and
  delegated in 3 of 42 sessions.
- The cost ranking of forced delegation against inline flips with the cache
  read weight in long sessions: cheaper under NaN weights, more expensive under
  API weights, on both models measured.
- Forced delegation produced smaller parents, longer sessions and lower
  key-fact scores, with the largest score loss on large and first questions.
- The analyzer's token counts agree with the provider's metering.

### Inferences (not directly measured)

- The shipped rule appears not to be applied rather than not triggered: its
  condition was met in many turns where the parent did not delegate. This
  matches #5139's 0 delegations under the old rules and the concern in
  gentle-ai#3411 that a rule written only as prose is not enforced.
- The cost flip follows the #5139 cost model: when a cache read costs as much
  as new input, carrying evidence in the parent for the remaining turns
  outweighs the child's start-up cost sooner. Child prefixes on NaN were about
  11 to 18k tokens (research log, T5), which may explain why the delegation
  penalty on short sessions with glm5.3-flash (1.03x) is much smaller than
  #5139's +46 to 65% with claude-bridge children of about 50k (lean) to 87k.
- The quality loss suggests that the bounded handoff from child to parent
  drops exact details (identifiers, values, conditions), which the key facts
  test for. #5139 saw no loss because its answers hit a ceiling; these keys are
  stricter.
- The single Spanish-drift session is plausibly a pull from the default
  persona; this was not verified.

### Limitations in brief

One repository and read-only questions; one repetition per short question;
forced rule texts written by the author; background subagents off; default
persona and no managed `AGENTS.md`, so lean child context is untested; one
judge calibrated on 30 answers with 11 negative fact verdicts; bootstrap over
pairs, not sessions; 18 of 168 sessions ran a newer Gentle Shell package with
the same rule assets; the qwen comparison of delegate against inline rests on
24 pairs. The full list is in
[METHODOLOGY.md](METHODOLOGY.md#11-limitations-and-threats-to-validity).
