# Question set

`gentle-shell-cc36bd8d.set.json` is the canonical question set for the
delegation benchmark (T4). It replicates the method of
Gentleman-Programming/gentle-ai#5139 on a larger scale: 12 real repository
questions (4 small, 4 medium, 4 large) instead of 8, each with one detail
follow-up, so the long session has 24 turns instead of 16.

The runner never reads the canonical set directly. It reads the generated
files under `generated/`.

## Target repository

The questions are about Gentle Shell, pinned at commit
`cc36bd8d10a4ccb16ad24a84860c4b9ee1a1e8ff`. Sessions run in a detached
worktree of that commit, expected as a sibling of this repository:

```text
<parent>/delegation-bench/                        this repository
<parent>/gentle-shell-worktrees/bench-cc36bd8d/   the pinned worktree (read-only)
```

`repository.worktree` in the set is relative to the set file, and every
generated `cwd` is relative to the generated file, so no absolute path is
committed. To recreate the worktree from a Gentle Shell clone:

```bash
git -C <gentle-shell clone> worktree add --detach \
  <parent>/gentle-shell-worktrees/bench-cc36bd8d cc36bd8d10a4ccb16ad24a84860c4b9ee1a1e8ff
```

## How the set was built

1. Read-only exploration of the pinned tree with `rg` and `bat` (no CodeGraph
   index existed there).
2. Candidate features were chosen so that each answer is:
   - answerable read-only (no edits, network, or test runs);
   - unambiguous and stable at this commit;
   - not guessable from file or symbol names (thresholds, precedence,
     failure behavior, non-obvious interactions).
3. Topics about the delegation rules, orchestrator assets, and lean child
   context were excluded, so the rule text of the arms cannot leak answers.
   Tools that the model sees in its own schema (for example the questionnaire
   tool) were avoided for the same reason.
4. Every key fact was checked against the code and cites `path:line`
   evidence in the pinned tree. The test suite checks that every cited file
   exists and every cited line range is inside the file, and that the
   worktree `HEAD` is the pinned commit.

## Size classes

| Size | Meaning | Questions |
|------|---------|-----------|
| `small` | Answerable from one symbol or one file, roughly under 10k tokens of reading. | NaN provider catalog and key, gauge rendering, Vim NORMAL counts, visual profiles |
| `medium` | Needs 2-4 files or one call chain. | Resume hint handoff, Esc handling, command palette, subscription usage |
| `large` | Cross-cutting flow or feature mapping across many files (roughly 30k+ tokens if read in full). | Launcher startup, prompt history, bash command guard, telemetry |

Every prompt, including follow-ups, ends with "Answer in English." (the
study observed a late-session drift to the persona's language).

## Set format

```json
{
  "id": "gentle-shell-cc36bd8d",
  "repository": { "name": "gentle-shell", "commit": "<40 hex>", "worktree": "<relative path>" },
  "questions": [
    {
      "id": "s1-nan-provider",
      "size": "small",
      "prompt": "... Answer in English.",
      "key": {
        "facts": [{ "id": "f1", "text": "atomic fact", "evidence": ["lib/nan-provider.ts:5-6"] }],
        "forbidden": [{ "id": "x1", "text": "common wrong claim", "evidence": ["lib/nan-provider.ts:48-53"] }]
      },
      "followup": { "prompt": "... Answer in English.", "key": { "facts": [] } }
    }
  ]
}
```

- `facts`: short atomic statements a correct answer must make. Each needs
  at least one `evidence` entry, `path:line` or `path:start-end`, relative
  to the target repository root.
- `forbidden` (optional): common wrong claims. Evidence is optional and
  points at the code that refutes the claim.
- Fact and forbidden ids are unique within a turn.

The builder rejects a malformed set: missing or empty `facts`, a fact without
evidence or with malformed evidence, duplicate ids, a size outside
`small|medium|large`, size counts other than 4/4/4, or a prompt that does not
end with "Answer in English.".

## Generated files

```bash
node scripts/build-question-files.mjs            # writes questions/generated/
node scripts/build-question-files.mjs --set <set.json> --out <dir>
```

| File | Content |
|------|---------|
| `generated/long.json` | One session with all 24 turns, largest questions first (large, medium, small; canonical order within a class), each question immediately followed by its follow-up. |
| `generated/short/<question-id>.json` | One two-turn session per question. |

Turn ids are `<question-id>` and `<question-id>-followup`. Each file carries
`set`, `repository`, and `commit`. Output is deterministic (the same set
produces the same bytes), and stale `short/` files are removed, so the
generated files are committed and a rerun produces no diff. Do not edit them
by hand: change the set and regenerate. A test fails when the committed
files are stale.

```bash
node run-bench.mjs --dry-run --arms shipped --questions questions/generated/long.json
node run-bench.mjs --dry-run --arms shipped --questions questions/generated/short/m1-resume-hint.json
```

## Grading

`grade.mjs` grades every answer blind against the `key` of its turn.
Method and calibration: [docs/METHODOLOGY.md](../docs/METHODOLOGY.md#9-answer-grading);
options: [docs/TOOLS.md](../docs/TOOLS.md#answer-grader); results:
[results/grading/](../results/grading/summary.md).

- The judge sees only the question prompt, the answer, the key facts and the
  forbidden claims, never the arm, model, run id or costs.
- A fact is supported when the answer makes the same claim in any wording,
  including the specific values, names or conditions in the fact; a vaguer or
  hedged statement is not supported.
- A forbidden claim counts when the answer states or clearly implies it. It
  does not lower the score but makes the answer not fully correct.
- Score = supported facts / total facts of the turn. Fully correct = every
  fact supported and no forbidden claim. Empty answers score 0 and are not
  sent to the judge.
- The reply language (`en`, `es`, `other`) is recorded separately,
  because every prompt asks for English.
- Turn ids map to keys as `<question-id>` and `<question-id>-followup`, and
  each answer's sent prompt must equal its key's prompt, so no answer is
  graded against the wrong key.

The published grades used the judge `pi/openai-codex/gpt-6.1-sol` with prompt
version `grade-v1`, calibrated on a 30-answer blind sample against an
independent reference (156 of 156 fact verdicts agreed).
