# Output formats

`--format text|markdown|json` renders one in-memory `ScopeResult`. Every format carries the same regions (merged
blocks of source, no line repeated) and the same provenance. Only the artifact goes to stdout; warnings and Jev usage
go to stderr, so JSON on stdout is always parseable on its own.

Selection still measures the text rendering against the budget. Counting Markdown and JSON size against the budget is
tracked separately (issue #53); the entry point is `renderFormat(format, result)` in `src/output/index.ts`.

## Text (default)

A `Scope context for: <task>` header, then each region as `== path:start-end names (labels) ==` followed by the source.

## Markdown

- `# Scope context`, the task in a fenced `text` block, then a summary list (mode, budget, estimated tokens, estimator,
  characters, lines, region count) and a `## Warnings` list when there are warnings.
- One section per region, headed with the `path:start-end` location as a code span: language, one line per chunk
  (name, kind, lines, and `relevance 0.87`, `score 1.00` or `supporting declaration`), then the source in a fenced
  block tagged with the language. Scores are ranking signals, not probabilities.
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
              chunks: [{ id, name?, kind, startLine, endLine, relevance?, score, reason, supportFor? }] }],
  warnings, unmetCoherence, skipped, retrievalConfigVersion? }
```

Source content appears once, on the region; chunk entries carry provenance only. `relevance` is absent in `no-jev`
mode. Selection signals and retrieval origin are not included yet (they arrive with `--explain`, issue #55).

### schemaVersion

`schemaVersion` is `1`. It is bumped on any breaking change: removing or renaming a key, changing a key's type or
meaning, or narrowing an enum. Adding an optional key is not breaking but must be added to the schema in the same
change. Consumers should reject a `schemaVersion` they do not know.
