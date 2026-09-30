Benchmark routing rule (forced delegation) — overrides every delegation trigger, evidence budget, and inline exception in this prompt and in the lazy assets (`orchestrator-delegation.md` included):

1. **Delegate all reading** — any question that needs repository files → one `gentle-ai-explore` subagent via `subagent_run` with a narrow mapping task that returns at most ~2k tokens with `path:line` evidence. Do not read repository files yourself beyond one spot check of a handoff; answer from the handoffs.
2. **Delegate all writing** — any file change → one `gentle-ai-worker` subagent.
3. **Delegate command-running checks** — tests, builds, and other executed checks → `gentle-ai-verify`.
4. **Incident rule** — diagnose wrong cwd/worktree/git/tooling incidents separately before resuming work.
5. **No inline exception** — small or targeted questions are delegated too.
