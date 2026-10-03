# Provenance: packages and settings per batch

| Batch | Package commit | Package version | Donor commit | Model | Arms | Sessions | Thinking | Context fixture | Background subagents |
|---|---|---|---|---|---|---|---|---|---|
| pilot-01 | `1162ce90` | 3.7.0 | `289cee5b` | nan/glm5.3-flash | old-rules | 12 | high | none | off |
| pilot-01 | `1162ce90` | 3.7.0 | - | nan/glm5.3-flash | delegate, inline, shipped | 36 | high | none | off |
| pilot-02-deepseek-v4-flash | `1162ce90` | 3.7.0 | `289cee5b` | nan/deepseek-v4-flash | old-rules | 12 | high | none | off |
| pilot-02-deepseek-v4-flash | `1162ce90` | 3.7.0 | - | nan/deepseek-v4-flash | delegate, inline, shipped | 36 | high | none | off |
| pilot-02-qwen3.8-flash | `1162ce90` | 3.7.0 | `289cee5b` | nan/qwen3.8-flash | old-rules | 9 | high | none | off |
| pilot-02-qwen3.8-flash | `1162ce90` | 3.7.0 | - | nan/qwen3.8-flash | delegate, inline, shipped | 33 | high | none | off |
| pilot-02-qwen3.8-flash | `2549f17a` | 3.7.0 | `289cee5b` | nan/qwen3.8-flash | old-rules | 3 | high | none | off |
| pilot-02-qwen3.8-flash | `2549f17a` | 3.7.0 | - | nan/qwen3.8-flash | shipped | 3 | high | none | off |
| long-01 | `1162ce90` | 3.7.0 | `289cee5b` | nan/glm5.3-flash | old-rules | 3 | high | none | off |
| long-01 | `1162ce90` | 3.7.0 | - | nan/glm5.3-flash | delegate, inline, shipped | 9 | high | none | off |
| long-02 | `2549f17a` | 3.7.0 | `289cee5b` | nan/deepseek-v4-flash | old-rules | 3 | high | none | off |
| long-02 | `2549f17a` | 3.7.0 | - | nan/deepseek-v4-flash | delegate, inline, shipped | 9 | high | none | off |

From each run's manifest: the Gentle Shell package directory every arm was copied from (commit from its directory name, version from its package.json), the donor package of the old-rules arm, and the run settings.
