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
   chunk. If everything is pruned, `BudgetTooSmallError` is raised (see below).

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
  and JSON it is a floor rather than a guarantee. It is deterministic, so a caller can tell the user which `--budget` would admit the chunk. One token less than
  `minimumBudget` never admits the chunk; a budget a few tokens above it does, when nothing else outranks it, because
  the selector reserves the embedded size numbers at their widest while choosing.
- `below-threshold`: the score was under the minimum relevance. This is expected filtering and is not warned about.
- The warning `N relevant chunk(s) were left out to stay within the budget.` counts only `over-budget` skips.
- A chunk skipped on its own turn but later included as another chunk's supporting declaration is not reported as
  skipped.

## Nothing relevant versus a budget too small

The two are different outcomes:

- **Nothing relevant** is a successful answer. Retrieval found no candidate, the repository has no analyzable chunk, or
  no candidate scored at least the minimum relevance. Scope prints the minimal valid artifact, which is the normal
  artifact with no chunks or regions (every below-threshold candidate still appears in `skipped` in JSON), and
  warns `No relevant chunks found...` (plus retrieval's guidance when it has some) on stderr. Exit code 0. Jev is not
  called when there is nothing to judge.
- **Budget too small** is a failure. Relevant chunks exist, but not even one fits, or the budget cannot hold even the
  empty artifact. `BudgetTooSmallError` is raised; the CLI prints nothing on stdout, exits 1, and the message says what
  is needed: `--budget must be at least N`. N is found by running the selection, so it counts everything in the
  artifact (skip list, warnings, embedded numbers): a run with `--budget N` succeeds and one with `N - 1` fails.

### Skip reasons

`SkipReason` has exactly two members, and each has one meaning:

| Reason            | Meaning                                                       | Shown in text and Markdown     |
| ----------------- | ------------------------------------------------------------- | ------------------------------ |
| `below-threshold` | The relevance (or `no-jev` score) was under the minimum.      | Count; listed with `--explain` |
| `over-budget`     | The chunk was relevant but did not fit, or was pruned to fit. | Listed, with cost and floor    |

Text and Markdown list at most five `over-budget` skips (most relevant first) and then count the rest, so the report
cannot starve the budget it is reporting on; JSON always lists every skip. The "Left out" and "Unmet coherence"
sections and the summary block are part of the artifact, so the selector reserves room for them (the skips and unmet
requirements recorded so far) while choosing and measures them in the final check.

### `--explain` counts toward the budget

The explanation section (text and Markdown) and the extra JSON fields (`signals`, `origin`, `estimatedTokens`,
`explain`) are part of the artifact, so `ScopeResult.explain` is threaded into selection and every candidate artifact
is measured with the evidence rendered. The evidence depends only on the chosen set and the skip list, which the
phase 1 reservation and the phase 2 final check already render, so `estimatedTokens <= budget` holds with it on. A
budget that fits a selection without `--explain` can therefore select fewer chunks with it. Under `--explain` the
below-threshold skips are also listed (capped at five, then a count), which is counted in the same measurement.
