# Answer quality: paired score differences

Graded answers: 864. Bootstrap: 5000 resamples, seed 5139.

| Comparison (A - B) | Subset | Pairs | Mean difference | 95% CI | A worse | A better | Ties |
|---|---|---|---|---|---|---|---|
| delegate - inline | all | 216 | -0.110 | [-0.145, -0.076] | 89 | 11 | 116 |
| delegate - shipped | all | 216 | -0.089 | [-0.120, -0.052] | 83 | 21 | 112 |
| delegate - old-rules | all | 216 | -0.101 | [-0.135, -0.073] | 84 | 15 | 117 |
| shipped - inline | all | 216 | -0.021 | [-0.045, 0.006] | 54 | 22 | 140 |
| old-rules - inline | all | 216 | -0.008 | [-0.032, 0.013] | 46 | 31 | 139 |
| delegate - inline | size=small | 72 | -0.036 | [-0.063, -0.012] | 14 | 3 | 55 |
| delegate - inline | size=medium | 72 | -0.073 | [-0.133, -0.013] | 28 | 4 | 40 |
| delegate - inline | size=large | 72 | -0.220 | [-0.277, -0.168] | 47 | 4 | 21 |
| delegate - inline | follow-ups | 108 | -0.053 | [-0.091, -0.016] | 25 | 4 | 79 |
| delegate - inline | first questions | 108 | -0.166 | [-0.214, -0.120] | 64 | 7 | 37 |
| delegate - inline | model=nan/glm5.3-flash | 96 | -0.139 | [-0.189, -0.092] | 43 | 5 | 48 |
| delegate - inline | model=nan/deepseek-v4-flash | 96 | -0.117 | [-0.152, -0.083] | 40 | 3 | 53 |
| delegate - inline | model=nan/qwen3.8-flash | 24 | 0.037 | [-0.087, 0.175] | 6 | 3 | 15 |
| delegate - inline | long sessions | 144 | -0.131 | [-0.173, -0.101] | 64 | 6 | 74 |
| delegate - inline | short sessions | 72 | -0.068 | [-0.128, -0.001] | 25 | 5 | 42 |

Score: supported key facts / total key facts per answer. A pair is two answers to the same turn in the same batch, model and replicate, one from each arm. Mean difference: mean of A score - B score over the pairs (negative means A covered fewer facts). 95% CI: percentile bootstrap of that mean. Subsets filter on the A answer.
