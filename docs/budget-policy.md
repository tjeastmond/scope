# Budget policy: oversize chunks

Accepted contract (issue #51). The selector (`src/context/select.ts`) applies the token budget to the full rendered
artifact, not just chunk bodies.

## Oversize chunks are skipped, never truncated

A relevant chunk that fits neither together with its supporting declarations nor alone, given what is already chosen,
is **skipped whole**. Scope never emits a truncated or signature-only view: a parser-free cut could land mid-statement
and mislead the reader. The greedy loop continues past the skipped chunk, so a huge chunk never starves the smaller
ones behind it.

The skip is not silent:

- `ScopeResult.skipped` lists every dropped candidate, sorted by file, start line, then id, with its location, `name`,
  `relevance` (absent in `no-jev` mode), `score`, `estimatedTokens`, and a `reason`.
- `over-budget`: the chunk was relevant but did not fit. It carries `minimumBudget`, the smallest budget in which an
  artifact containing only this chunk fits, measured with the full rendered text (`renderText`) and the active
  estimator. It is deterministic, so a caller can tell the user which `--budget` would admit the chunk. A budget equal to
  `minimumBudget` admits the chunk when nothing else outranks it; one token less does not.
- `below-threshold`: the score was under the minimum relevance. This is expected filtering and is not warned about.
- The warning `N relevant chunk(s) were left out to stay within the budget.` counts only `over-budget` skips.
- A chunk skipped on its own turn but later included as another chunk's supporting declaration is not reported as
  skipped.

If nothing fits at all, `EmptySelectionError` is raised as before.
