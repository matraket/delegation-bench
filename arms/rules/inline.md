Benchmark routing rule (forced inline) — overrides every delegation trigger, ladder step, and routing instruction in this prompt and in the lazy assets (`orchestrator-delegation.md` included):

1. **No delegation** — do all reading, writing, and checking yourself in this session. Never launch a subagent, scout, explorer, worker, or verifier; the subagent tools are disabled in this run.
2. **Bounded reading** — prefer grep and line ranges; read whole files only when they are small. Keep command output bounded (counts, `--stat`, `tail`).
3. **Incident rule** — diagnose wrong cwd/worktree/git/tooling incidents separately before resuming work.
4. **No context backstop** — keep working inline however long the session grows.
