# Report pilot-01-

pilot-01-: 48 sessions, statuses completed, turns settled 96, prompt 19219284, output 243946, zero-usage turns 1

## nan/glm5.3-flash (short, 48 sessions)

| Arm | Sessions that delegated | Children | NaN total | NaN median | Median vs inline | API median | Final parent context (median) | Wall (median) | Turns over budget | Max evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| old-rules | 0 | 0 | 4.84M | 286k | 0.76x | 97k | 36.2k | 154 s | 9/24 | 48.3k |
| inline | 0 | 0 | 6.06M | 297k | 1.00x | 90k | 33.2k | 144 s | 10/24 | 33.5k |
| shipped | 0 | 0 | 3.87M | 234k | 0.85x | 73k | 31.4k | 169 s | 9/24 | 32.4k |
| delegate | 12 | 21 | 4.69M | 330k | 1.03x | 138k | 23.9k | 327 s | 0/24 | 3.1k |

### By question size

| Size | Arm | Sessions | Delegated | NaN median | Median vs inline | Final parent context (median) | Turns over budget | Spanish turns |
|---|---|---|---|---|---|---|---|---|
| small | old-rules | 4 | 0 | 100k | 0.80x | 24.3k | 2/8 | 0 |
| small | inline | 4 | 0 | 178k | 1.00x | 22.9k | 2/8 | 0 |
| small | shipped | 4 | 0 | 174k | 1.07x | 23.7k | 3/8 | 0 |
| small | delegate | 4 | 4 | 173k | 1.13x | 22.8k | 0/8 | 0 |
| medium | old-rules | 4 | 0 | 287k | 0.89x | 37.8k | 3/8 | 0 |
| medium | inline | 4 | 0 | 291k | 1.00x | 32.1k | 4/8 | 0 |
| medium | shipped | 4 | 0 | 234k | 0.74x | 30.2k | 2/8 | 0 |
| medium | delegate | 4 | 4 | 363k | 1.30x | 24.5k | 0/8 | 0 |
| large | old-rules | 4 | 0 | 405k | 0.64x | 41.9k | 4/8 | 0 |
| large | inline | 4 | 0 | 613k | 1.00x | 48.6k | 4/8 | 0 |
| large | shipped | 4 | 0 | 581k | 0.95x | 47.7k | 4/8 | 0 |
| large | delegate | 4 | 4 | 438k | 0.72x | 24.4k | 0/8 | 0 |

Costs are weighted token totals over the parent and its children (`nan`: cache reads 1:1; `api`: cache read 0.1, cache write 1.25, output 5). Turns over budget: user turns where the parent read more than 10k tokens of tool results (chars/4) or ran more than 5 tool rounds. Median vs inline: median over questions of the per-question NaN cost ratio. Spanish turns: crude word-count heuristic on the last assistant text of each turn; late = turn 13 onwards.
