# Report long-01-

long-01-: 12 sessions, statuses completed, turns settled 288, prompt 95815510, output 574639, zero-usage turns 1

## nan/glm5.3-flash (long, 12 sessions)

| Arm | Reps that delegated | Children | NaN median (min-max) | API-weight median | Peak parent context (median) | Final parent context (median) | Wall (median) | Turns over budget | Spanish turns (late) |
|---|---|---|---|---|---|---|---|---|---|
| old-rules | 0/3 | 0 | 8.82M (7.88-10.75M) | 1.53M | 156.6k | 156.6k | 27 min | 19/72 | 0 (0) |
| inline | 0/3 | 0 | 9.31M (9.17-10.61M) | 1.51M | 157.8k | 157.8k | 32 min | 16/72 | 0 (0) |
| shipped | 0/3 | 0 | 8.35M (7.27-9.44M) | 1.30M | 152.1k | 152.1k | 28 min | 13/72 | 0 (0) |
| delegate | 3/3 | 61 | 4.13M (3.92-6.75M) | 1.88M | 79.6k | 79.6k | 49 min | 1/72 | 0 (0) |

Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.
