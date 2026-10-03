Following up on my earlier comment: I ran a wider sample on NaN Builders models against the rules shipped in Gentleman-Programming/gentle-shell#1590. I'm sharing what I got, but I want to be upfront that my benchmark or my method may well be wrong in ways I haven't spotted, so please take this as something to check rather than as evidence. The original harness wasn't available, so I built my own following your description; any difference with your numbers could come from my setup rather than from the models.

Everything is public so it can be reviewed or corrected: https://github.com/matraket/delegation-bench ([method](https://github.com/matraket/delegation-bench/blob/main/docs/METHODOLOGY.md), [how to reproduce](https://github.com/matraket/delegation-bench/blob/main/docs/REPRODUCE.md), [results](https://github.com/matraket/delegation-bench/blob/main/docs/RESULTS.md)).

**What I did**

- Gentle Shell driven over RPC, one isolated home per session, one package copy per arm (`--package-root`). The rule assets were byte-identical to #1590 in every run; package commits per batch are in [`results/provenance.md`](https://github.com/matraket/delegation-bench/blob/main/results/provenance.md).
- 4 arms: pre-#1590 rules, forced inline, the shipped evidence budget, and forced delegation.
- 12 questions about a pinned Gentle Shell commit (4 small, 4 medium, 4 large), each with a follow-up and a key of facts verified with `path:line`.
- Short sessions (2 turns) on glm5.3-flash, deepseek-v4-flash and qwen3.8-flash; long sessions (24 turns, 3 repetitions) on glm5.3-flash and deepseek-v4-flash. 168 sessions in total.
- Cost comes from the session JSONL; it matched NaN's usage endpoint exactly in 3 of 5 batches and within 0.37% in the other two. NaN appears to count cache reads in full, so I report two weightings: NaN (everything at 1) and your API weights (cache read 0.1).
- Answers were graded blind against the key facts with gpt-6.1-sol as judge, calibrated on 30 answers against an independent reference.

**Where my method could be wrong**

- **The forced arms are my own wording.** The forced-inline and forced-delegation rule texts are mine, not yours; a different wording could change both cost and quality.
- **The questions are read-only and from one repository.** They don't exercise writing or verification, where you found delegation pays off most.
- **The keys may be unfair to delegation.** They reward exact identifiers (event names, exit codes, error texts), which a short child summary is likely to drop even when the answer is useful.
- **The judge is one model**, calibrated on only 30 answers with 11 negative facts. Perfect agreement on that sample is encouraging but not strong evidence.
- **Small samples:** one repetition for the short sessions and three for the long ones.
- **My setup differs from a real one:** background subagents off, default persona, isolated homes without the usual packages, and two package commits across batches (same rule assets).
- **I may be misreading the cost model,** in particular how cache reads should be weighted for a subscription like NaN.

If any of this invalidates the results, I'd rather know.

**What the numbers show, with those caveats**

*Rule adherence*

| Model | Short sessions that delegated (shipped rule) | Turns over the budget | Short sessions that delegated (pre-#1590 rules) |
|---|---|---|---|
| glm5.3-flash | 0 of 12 | 9 of 24 | 0 of 12 |
| deepseek-v4-flash | 1 of 12 | 12 of 24 | 3 of 12 |
| qwen3.8-flash | 1 of 12 | 14 of 24 | 6 of 12 |

In the long sessions the shipped rule delegated 0 times in 72 turns on glm5.3-flash and once on deepseek-v4-flash. That would be consistent with the point in #3411, if it holds up.

*Cost under two weightings*

| Long session, forced delegation vs inline | glm5.3-flash | deepseek-v4-flash |
|---|---|---|
| NaN weights (cache read at 1) | 0.44x | 0.72x |
| API weights (cache read at 0.1) | 1.25x | 1.18x |
| Final parent context | -50% | -35% |

On the short questions, forced delegation cost 1.03x, 1.60x and 1.85x of inline (glm, deepseek, qwen). If I read your cost model correctly, this fits it: the sign of the difference depends mostly on how cache reads are priced.

*Answer quality*

- Forced delegation scored lower than inline on the key facts: -0.110 (95% CI -0.145 to -0.076), lower in 89 paired turns and higher in 11.
- The gap was larger on large questions (-0.220) and small on follow-ups (-0.05). The three arms that answered inline were indistinguishable.
- Given the point above about the keys, this may say as much about my grading as about delegation.

*Other observations*

- Forced delegation took 1.5x to 2.3x the inline wall time.
- One long forced-delegation session (deepseek) answered 22 of 24 turns in Spanish although English was requested; no other session did.

Any feedback on the method is very welcome. I'm happy to fix what's wrong and rerun, or to try other models or variants if that helps.
