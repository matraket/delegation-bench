# Usage control: provider usage endpoint versus the session analyzer

| Batch | Models | Sessions | Provider prompt | Analyzer prompt | Prompt diff | Provider completion | Analyzer output | Output diff | Provider requests | Zero-usage turns |
|---|---|---|---|---|---|---|---|---|---|---|
| pilot-01 | nan/glm5.3-flash | 48 | 19,234,669 | 19,219,284 | -0.08% | 243,946 | 243,946 | +0.00% | 732 | 1 |
| pilot-02-deepseek-v4-flash | nan/deepseek-v4-flash | 48 | 22,950,932 | 22,950,932 | +0.00% | 507,851 | 507,851 | +0.00% | 786 | 0 |
| pilot-02-qwen3.8-flash | nan/qwen3.8-flash | 48 | 64,637,039 | 64,436,504 | -0.31% | 982,938 | 986,557 | +0.37% | 1,720 | 6 |
| long-01 | nan/glm5.3-flash | 12 | 95,815,510 | 95,815,510 | +0.00% | 574,639 | 574,639 | +0.00% | 1,360 | 1 |
| long-02 | nan/deepseek-v4-flash | 12 | 196,730,717 | 196,730,717 | +0.00% | 1,529,243 | 1,529,243 | +0.00% | 1,953 | 0 |

Provider: difference between the usage endpoint readings logged before and after the batch (`usage-before` / `usage-after` in the batch's progress.log), for the batch model only. Analyzer: sum over the batch sessions of input + cache read + cache write (prompt) and output, parent plus children, from each run's analysis.json. Diff: (analyzer - provider) / provider.
