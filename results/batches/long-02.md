# Report long-02-

long-02-: 12 sessions, statuses completed, turns settled 288, prompt 196730717, output 1529243, zero-usage turns 0

## nan/deepseek-v4-flash (long, 12 sessions)

| Arm | Reps that delegated | Children | NaN median (min-max) | API-weight median | Peak parent context (median) | Final parent context (median) | Wall (median) | Turns over budget | Spanish turns (late) |
|---|---|---|---|---|---|---|---|---|---|
| old-rules | 3/3 | 7 | 18.19M (16.73-20.24M) | 2.85M | 254.0k | 254.0k | 21 min | 20/72 | 0 (0) |
| inline | 0/3 | 0 | 15.76M (14.99-34.87M) | 2.30M | 263.9k | 263.9k | 19 min | 23/72 | 0 (0) |
| shipped | 1/3 | 1 | 11.94M (11.42-18.79M) | 2.00M | 246.2k | 246.2k | 21 min | 18/72 | 0 (0) |
| delegate | 3/3 | 49 | 11.41M (10.86-13.06M) | 2.72M | 170.5k | 170.5k | 34 min | 1/72 | 22 (12) |

Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.
