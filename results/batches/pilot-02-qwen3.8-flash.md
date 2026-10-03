# Report pilot-02-qwen3.8-flash-

pilot-02-qwen3.8-flash-: 48 sessions, statuses completed, turns settled 96, prompt 64436504, output 986557, zero-usage turns 6

## nan/qwen3.8-flash (short, 48 sessions)

| Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline | API median | Final parent context (median) | Wall (median) | Turns over budget | Max evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| old-rules | 6 | 8 | 23.53M | 1.45M | 1.28x | 312k | 49.9k | 364 s | 17/24 | 35.7k |
| inline | 0 | 0 | 11.34M | 799k | 1.00x | 190k | 54.2k | 267 s | 19/24 | 41.5k |
| shipped | 1 | 2 | 8.85M | 660k | 0.64x | 166k | 48.7k | 238 s | 14/24 | 32.2k |
| delegate | 12 | 37 | 21.70M | 1.73M | 1.85x | 497k | 35.8k | 540 s | 4/24 | 10.0k |

### By question size

| Size | Arm | Sessions | Delegated | NaN median | Median vs inline | Final parent context (median) | Turns over budget | Spanish turns |
|---|---|---|---|---|---|---|---|---|
| small | old-rules | 4 | 1 | 671k | 0.98x | 41.9k | 5/8 | 0 |
| small | inline | 4 | 0 | 741k | 1.00x | 46.4k | 7/8 | 0 |
| small | shipped | 4 | 0 | 471k | 0.68x | 42.2k | 4/8 | 0 |
| small | delegate | 4 | 4 | 756k | 1.10x | 27.1k | 0/8 | 0 |
| medium | old-rules | 4 | 1 | 881k | 0.97x | 48.5k | 5/8 | 0 |
| medium | inline | 4 | 0 | 799k | 1.00x | 50.8k | 7/8 | 0 |
| medium | shipped | 4 | 0 | 660k | 0.77x | 49.9k | 5/8 | 0 |
| medium | delegate | 4 | 4 | 2.41M | 3.12x | 39.9k | 3/8 | 0 |
| large | old-rules | 4 | 4 | 2.45M | 2.77x | 74.8k | 7/8 | 0 |
| large | inline | 4 | 0 | 1.41M | 1.00x | 67.4k | 5/8 | 0 |
| large | shipped | 4 | 1 | 968k | 0.63x | 60.1k | 5/8 | 0 |
| large | delegate | 4 | 4 | 2.34M | 1.93x | 37.6k | 1/8 | 0 |

Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.
