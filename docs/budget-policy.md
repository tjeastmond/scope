# Budget policy

Accepted contracts (issues #51 and #53). The selector (`src/context/select.ts`) applies the token budget to the full
emitted artifact, not just chunk bodies.

## The budget promise

The budget is enforced on the **entire emitted artifact in the requested format** (`--format text|markdown|json`):
headers, code fences, per-chunk metadata, warnings, the skipped and unmet lists, and the size metrics the artifact
embeds about itself, all measured with the configured estimator (`scope-heuristic-v1` by default). The estimator is
conservative: it over-estimates real BPE token counts by about 1.48x on the back-test in
[token-estimator.md](token-estimator.md), so a real tokenizer will usually count fewer tokens than the budget. The
estimator id is reported in every format, so `estimatedTokens` is always an estimate under a named estimator, never a
claim about a specific model's tokenizer.

How it is enforced, deterministically and in bounded work:

1. **Selection with a reservation.** Each candidate set is rendered as a provisional artifact in the requested format
   and measured, so the fixed overhead of the format is charged. The numbers and warnings that are only known after
   selection (`estimatedTokens`, `characters`, `lines`, and the two selection warnings) are reserved at their widest
   plausible size, and the skip list recorded so far is included.
2. **Final measurement.** The true artifact (real skip list, unmet requirements, warnings) is rendered. Its embedded
   metrics are found by fixed-point iteration (render, measure, repeat; at most 8 rounds, then the per-field maximum
   is used so the artifact never under-reports). For text, which embeds no metrics, they equal the measures of the
   emitted text exactly.
3. **Prune until it fits.** If the artifact is still over budget, the lowest-value chosen chunk is dropped (lowest
   relevance, or score in `no-jev` mode; ties by lowest score per token, then the later location), together with
   supporting declarations only it required, and recorded in `skipped` as `over-budget`. At most one round per chosen
   chunk. If everything is pruned, `EmptySelectionError` is raised.

Scan and retrieval warnings and `retrievalConfigVersion` are measured too, because they are part of the artifact.

## Oversize chunks are skipped, never truncated

A relevant chunk that fits neither together with its supporting declarations nor alone, given what is already chosen,
is **skipped whole**. Scope never emits a truncated or signature-only view: a parser-free cut could land mid-statement
and mislead the reader. The greedy loop continues past the skipped chunk, so a huge chunk never starves the smaller
ones behind it.

The skip is not silent:

- `ScopeResult.skipped` lists every dropped candidate, sorted by file, start line, then id, with its location, `name`,
  `relevance` (absent in `no-jev` mode), `score`, `estimatedTokens`, and a `reason`.
- `over-budget`: the chunk was relevant but did not fit. It carries `minimumBudget`, the smallest budget in which an
  artifact containing only this chunk fits, measured on the artifact in the requested format with the active
  estimator. The skip list and selection warnings depend on the rest of the run and are not included, so in Markdown
  and JSON it is a floor rather than a guarantee. It is deterministic, so a caller can tell the user which `--budget` would admit the chunk. A budget equal to
  `minimumBudget` admits the chunk when nothing else outranks it; one token less does not.
- `below-threshold`: the score was under the minimum relevance. This is expected filtering and is not warned about.
- The warning `N relevant chunk(s) were left out to stay within the budget.` counts only `over-budget` skips.
- A chunk skipped on its own turn but later included as another chunk's supporting declaration is not reported as
  skipped.

If nothing fits at all, `EmptySelectionError` is raised as before.
