# Token estimator

Scope enforces its token budget with a deterministic, dependency-free heuristic, `scope-heuristic-v1`
(`src/context/tokens.ts`, exported as `heuristicEstimator`). It is the default everywhere: chunk
`estimatedTokens`, budget selection, and Jev request batching. `ScopeResult.estimator` carries its id.

## Algorithm

A single linear pass over the string (no regular expressions, so no backtracking):

- Letter runs are split into camelCase segments and cost `ceil(len / 4)` each.
- Digit runs cost `ceil(len / 2)`.
- Runs of adjacent ASCII punctuation and control characters (including `_` and NUL) cost `ceil(len / 2)`.
- Whitespace runs (spaces, tabs, `\r`, `\n`) cost 1, plus 1 per extra newline, plus 1 per 8 characters of the run. A
  lone space between words is free.
- Non-ASCII code points cost 2 (BMP) or 3 (astral code points and lone surrogates).
- The result is the larger of the sum and `ceil(length / 3)`.

It is a pure function; appending text never decreases the count. The constants are general properties of code and prose
tokenization, not tuned to individual files.

## Back-test

Run `bun scripts/backtest-estimator.ts` (dev only, uses the `gpt-tokenizer` devDependency; never imported by shipped
code). Result for `scope-heuristic-v1` on 2026-10-06 against `o200k_base`, over every text file of
`fixtures/mixed-app` and `fixtures/webhook-service` (53 files):

| Group   | Files | Estimate | Real | Ratio |
| ------- | ----: | -------: | ---: | ----: |
| css     |     2 |      195 |  147 | 1.327 |
| example |     1 |       61 |   43 | 1.419 |
| html    |     1 |      192 |  160 | 1.200 |
| js      |     1 |       42 |   26 | 1.615 |
| json    |     1 |       73 |   64 | 1.141 |
| md      |     3 |      406 |  286 | 1.420 |
| py      |     7 |     1426 |  960 | 1.485 |
| scss    |     1 |      154 |  121 | 1.273 |
| sql     |     3 |      383 |  264 | 1.451 |
| toml    |     1 |      110 |   84 | 1.310 |
| ts      |    25 |     5369 | 3495 | 1.536 |
| tsx     |     5 |      705 |  476 | 1.481 |
| txt     |     1 |       14 |   12 | 1.167 |
| yml     |     1 |      118 |  101 | 1.168 |
| overall |    53 |     9248 | 6239 | 1.482 |

No file group under-estimates. The lowest single file ratio is `fixtures/mixed-app/config/settings.json` at 1.141
(still above 1.0), so no file under-estimates either.

## Limitations

- There is no model-specific tokenizer. Claude's tokenizer is not public; `o200k_base` is only a proxy for how a
  modern BPE tokenizer treats code.
- The budget is enforced under this estimator. It cannot guarantee identical counts for every model, and unusual
  content (long runs of rare scripts, base64, minified code) may deviate more than the fixtures do.
- The estimator deliberately over-estimates (about 1.1 to 1.5 times on the fixtures), so a budget selects somewhat
  less code than it nominally allows.
- Model-specific tokenizers are a later extension.
- Changing the algorithm or any constant must bump the estimator id (`HEURISTIC_ESTIMATOR_ID`), because the id is
  part of results and of M6 cache invalidation.
