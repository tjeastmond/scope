# Output formats

`--format text|markdown|json` renders one in-memory `ScopeResult`. Every format carries the same regions (merged
blocks of source, no line repeated) and the same provenance. Only the artifact goes to stdout (or to the `--output`
file); warnings and Jev usage go to stderr, so JSON on stdout is always parseable on its own.

The budget is enforced on the whole artifact in the requested format, so Markdown and JSON, which carry more
structure, select less source than text for the same `--budget` (see [budget-policy.md](budget-policy.md)). The entry
point is `renderFormat(format, result)` in `src/output/index.ts`.

## Flags

- `--output <path>`: write the artifact to a file instead of stdout. The file holds exactly the bytes stdout would have
  received; stdout stays empty. Warnings, Jev usage and a final `scope: wrote <path>` line go to stderr.
- `--explain`: add the selection evidence described under [Explanation](#explanation---explain). The evidence is part
  of the artifact, so it counts toward `--budget` (see [budget-policy.md](budget-policy.md)).

### Output file safety (`--output`)

- **Never overwrites repository source.** The target is resolved through symlinks (the file's real path when it
  exists, otherwise its parent directory's real path plus the file name) and compared with the files Scope scans
  (the eligible set: not ignored, not binary, not secret). If it is one of them, Scope refuses with a one-line message
  and exit code 1, and writes nothing. A target inside the repository that is not scanned (for example an ignored
  path) and any file outside it, such as a previous Scope output, may be overwritten. A directory target is refused.
- **Checked before the Jev request.** After parsing, and before any request is sent, Scope runs the check above and
  creates the temporary file, so a missing or unwritable directory fails immediately (exit code 1) instead of after a
  paid run.
- **Atomic.** The artifact is written to a temporary file in the target's directory (exclusive create, named
  `.<name>.<16 random hex digits>.tmp`) and renamed over the target, so a reader sees the old file or the complete new
  one. The temporary file is removed on every failure path.

## Explanation (`--explain`)

For every chunk in the result, including supporting declarations pulled in for coherence, the evidence is: the
deterministic retrieval signals (names sorted), Jev's relevance (or `not judged`), the ranking score, the chunk's
estimated token cost, its origin and the reason it was included. Origin is `direct` (dependency distance 0),
`expanded from <location>` (a graph neighbour of that chunk, distance 1) or `supporting declaration for <locations>`.
Under `--explain` the below-threshold candidates are also listed (most relevant first, at most five, then a count)
in addition to the over-budget list; without it they are only counted.

- **Text:** a `-- Explanation --` section after the regions, one block per chunk; repo-derived text is sanitized.
- **Markdown:** `## Explanation` with one `###` section per chunk; repo-derived text is in code spans.
- **JSON:** each region chunk gains `signals` (object, keys sorted), `origin` (when known) and `estimatedTokens`, and
  the document gains `"explain": true`. These are additive optional properties; `schemaVersion` stays `1`. Without
  `--explain` the JSON is unchanged.

The text and Markdown lines are built once in `src/output/report.ts`, so the formats cannot drift.

## Text (default)

A `Scope context for: <task>` header, a summary block, then each region as `== path:start-end names (labels) ==`
followed by the source, then the report sections below.

### Summary and report sections (text and Markdown)

Text and Markdown share one set of facts (`src/output/report.ts`):

- **Summary:** mode, budget, estimated tokens with the estimator id, characters, lines, number of regions, and
  `retrievalConfigVersion` when present. Numbers are estimates from the named estimator, not exact model token counts.
- **Left out (over budget):** the relevant chunks that did not fit, most relevant first, with location, `relevance` or
  `score`, estimated tokens and the minimum budget that would admit the chunk. At most five are listed, then a count of the
  rest. Candidates scored below the relevance minimum are only counted, never listed.
- **Unmet coherence:** each selected chunk whose required supporting declaration is not included, with the reason
  (`too-large` or `over-budget`).
- Empty sections are omitted. `relevance` is Jev's judgment; `score` is a ranking signal. Neither is a probability or
  a confidence.
- JSON keeps its structure and lists every skip and unmet entry in full.

Golden files for all three formats live in `tests/golden/`; regenerate with
`UPDATE_GOLDEN=1 bun test tests/golden.test.ts` and review the diff.

## Markdown

- `# Scope context`, the task in a fenced `text` block, then a summary list (mode, budget, estimated tokens, estimator,
  characters, lines, region count) and a `## Warnings` list when there are warnings.
- One section per region, headed with the `path:start-end` location as a code span: language, one line per chunk
  (name, kind, lines, and `relevance 0.87`, `score 1.00` or `supporting declaration`), then the source in a fenced
  block tagged with the language. Scores are ranking signals, not probabilities.
- After the regions: `## Left out` and `## Unmet coherence` when they have content (see below).
- **Fence rule.** A fence is a run of backticks longer than the longest backtick run anywhere inside the fenced content,
  and never shorter than 3. Content is emitted unchanged inside the fence: CR, NUL, ANSI escapes, U+2028/2029, BOMs and
  very long lines are not altered.
- Text taken from the repository (paths, symbol names, the estimator id) appears only inside code spans, which use the
  same longest-run rule plus one space of padding. Control characters and line breaks in such text become U+FFFD.

## JSON

`JSON.stringify(payload, null, 2)` plus a trailing newline. Key order is fixed. The contract is
[`scope-result.schema.json`](scope-result.schema.json) (JSON Schema 2020-12, `additionalProperties: false` everywhere).

```
{ schemaVersion: 1, mode, task, budget, estimator, estimatedTokens, characters, lines,
  regions: [{ file, language, startLine, endLine, content,
              chunks: [{ id, name?, kind, startLine, endLine, relevance?, score, reason, supportFor?,
                         signals?, origin?, estimatedTokens? }] }],
  warnings, unmetCoherence, skipped, retrievalConfigVersion?, explain? }
```

Source content appears once, on the region; chunk entries carry provenance only. `relevance` is absent in `no-jev`
mode. `signals`, `origin` and `estimatedTokens` on a chunk, and the top-level `explain`, appear only with `--explain`.

### schemaVersion

`schemaVersion` is `1`. It is bumped on any breaking change: removing or renaming a key, changing a key's type or
meaning, or narrowing an enum. Adding an optional key is not breaking but must be added to the schema in the same
change. Consumers should reject a `schemaVersion` they do not know.
