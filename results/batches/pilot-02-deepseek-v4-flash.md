# Report pilot-02-deepseek-v4-flash-

pilot-02-deepseek-v4-flash-: 48 sessions, statuses completed, turns settled 96, prompt 22950932, output 507851, zero-usage turns 0

## nan/deepseek-v4-flash (short, 48 sessions)

| Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline | API median | Final parent context (median) | Wall (median) | Turns over budget | Max evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| old-rules | 3 | 4 | 6.99M | 410k | 1.72x | 115k | 38.2k | 118 s | 10/24 | 44.6k |
| inline | 0 | 0 | 4.41M | 312k | 1.00x | 84k | 37.1k | 83 s | 11/24 | 32.5k |
| shipped | 1 | 1 | 6.28M | 438k | 1.20x | 106k | 45.8k | 101 s | 12/24 | 36.5k |
| delegate | 12 | 21 | 5.78M | 441k | 1.60x | 178k | 26.8k | 165 s | 0/24 | 3.9k |

### By question size

| Size | Arm | Sessions | Delegated | NaN median | Median vs inline | Final parent context (median) | Turns over budget | Spanish turns |
|---|---|---|---|---|---|---|---|---|
| small | old-rules | 4 | 0 | 303k | 1.87x | 34.6k | 4/8 | 0 |
| small | inline | 4 | 0 | 170k | 1.00x | 27.5k | 2/8 | 0 |
| small | shipped | 4 | 0 | 227k | 1.16x | 35.3k | 2/8 | 0 |
| small | delegate | 4 | 4 | 263k | 2.06x | 24.5k | 0/8 | 0 |
| medium | old-rules | 4 | 1 | 353k | 1.04x | 38.2k | 3/8 | 0 |
| medium | inline | 4 | 0 | 342k | 1.00x | 38.9k | 4/8 | 0 |
| medium | shipped | 4 | 0 | 438k | 1.18x | 47.3k | 5/8 | 0 |
| medium | delegate | 4 | 4 | 527k | 1.53x | 28.8k | 0/8 | 0 |
| large | old-rules | 4 | 2 | 936k | 2.40x | 52.0k | 3/8 | 0 |
| large | inline | 4 | 0 | 618k | 1.00x | 58.4k | 5/8 | 0 |
| large | shipped | 4 | 1 | 552k | 1.62x | 56.5k | 5/8 | 0 |
| large | delegate | 4 | 4 | 591k | 1.32x | 27.9k | 0/8 | 0 |

Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.
