# Output formats

`--format text|markdown|json` renders one in-memory `ScopeResult`. Every format carries the same regions (merged
blocks of source, no line repeated) and the same provenance. Only the artifact goes to stdout (or to the `--output`
file); warnings and Jev usage go to stderr, so JSON on stdout is always parseable on its own.

Selection is relevance-only and the same for every format; there is no size limit (see
[selection-policy.md](selection-policy.md)). The entry point is `renderFormat(format, result)` in
`src/output/index.ts`.

## Flags

- `--output <path>`: write the artifact to a file instead of stdout. The file holds exactly the bytes stdout would have
  received; stdout stays empty. Warnings, Jev usage and a final `scope: wrote <path>` line go to stderr.
- `--explain`: add the selection evidence described under [Explanation](#explanation---explain). The evidence changes
  how a result is rendered, never which chunks it contains.

### Output file safety (`--output`)

- **Never overwrites repository source.** The target is resolved through symlinks (the file's real path when it
  exists, otherwise its parent directory's real path plus the file name) and compared with the files Scope scans
  (the eligible set: not ignored, not binary, not secret). If it is one of them, Scope refuses with a one-line message
  and exit code 1, and writes nothing. A target inside the repository that is not scanned (for example an ignored
  path) and any file outside it, such as a previous Scope output, may be overwritten. A directory target is refused, and so is an existing in-repository file when the scan was truncated by a limit (it cannot then be shown not to be source).
- **Checked before the Jev request.** After parsing, and before any request is sent, Scope runs the check above and
  probes that the directory accepts a new file (the probe is removed again, so it cannot be scanned), so a missing or unwritable directory fails immediately (exit code 1) instead of after a
  paid run.
- **Atomic.** The artifact is written to a temporary file in the target's directory (exclusive create, named
  `.scope-<16 random hex digits>.tmp`) and renamed over the target, so a reader sees the old file or the complete new
  one. The temporary file is removed on every failure path.

## Explanation (`--explain`)

For every chunk in the result, including supporting declarations pulled in for coherence, the evidence is: the
deterministic retrieval signals (names sorted), Jev's relevance (or `not judged`), the ranking score, its origin and
the reason it was included. Origin is `direct` (dependency distance 0),
`expanded from <location>` (a graph neighbour of that chunk, distance 1) or `supporting declaration for <locations>`.
Under `--explain` the below-threshold candidates are also listed, most relevant first; without it they are only
counted.

- **Text:** a `-- Explanation --` section after the regions, one block per chunk; repo-derived text is sanitized.
- **Markdown:** `## Explanation` with one `###` section per chunk; repo-derived text is in code spans.
- **JSON:** each region chunk gains `signals` (object, keys sorted) and `origin` (when known), and
  the document gains `"explain": true`. These are additive optional properties. Without
  `--explain` the JSON is unchanged.

The text and Markdown lines are built once in `src/output/report.ts`, so the formats cannot drift.

## Text (default)

A `Scope context for: <task>` header, a summary block, then each region as `== path:start-end names (labels) ==`
followed by the source, then the report sections below.

### Summary and report sections (text and Markdown)

Text and Markdown share one set of facts (`src/output/report.ts`):

- **Summary:** mode, number of regions, a `Decisions reused from <time>` line when a stored Jev decision was reused (always shown), `retrievalConfigVersion` when present, and `jevQuestionVersion` (the version of the Jev question text and criteria; absent in `no-jev` mode). The artifact reports no size. With `--explain` the summary also shows Jev's request count, wall-clock latency and token usage (`Jev requests`, `Jev latency`, `Jev tokens`), kept out of the default output.
- **Left out (below relevance minimum):** with `--explain`, every candidate that scored below the minimum, most
  relevant first, with location and `relevance` or `score`. Without it they are only counted, never listed.
- Empty sections are omitted. `relevance` is Jev's judgment; `score` is a ranking signal. Neither is a probability or
  a confidence.
- JSON keeps its structure and lists every skip in full.

Golden files for all three formats live in `tests/golden/`; regenerate with
`UPDATE_GOLDEN=1 bun test tests/golden.test.ts` and review the diff.

## Markdown

- `# Scope context`, the task in a fenced `text` block, then a summary list (mode, region count) and a `## Warnings` list when there are warnings.
- One section per region, headed with the `path:start-end` location as a code span: language, one line per chunk
  (name, kind, lines, and `relevance 0.87`, `score 1.00` or `supporting declaration`), then the source in a fenced
  block tagged with the language. Scores are ranking signals, not probabilities.
- After the regions: `## Left out` when it has content (see above).
- **Fence rule.** A fence is a run of backticks longer than the longest backtick run anywhere inside the fenced content,
  and never shorter than 3. Content is emitted unchanged inside the fence: CR, NUL, ANSI escapes, U+2028/2029, BOMs and
  very long lines are not altered.
- Text taken from the repository (paths, symbol names) appears only inside code spans, which use the
  same longest-run rule plus one space of padding. Control characters and line breaks in such text become U+FFFD.

## JSON

`JSON.stringify(payload, null, 2)` plus a trailing newline. Key order is fixed. The contract is
[`scope-result.schema.json`](scope-result.schema.json) (JSON Schema 2020-12, `additionalProperties: false` everywhere).

```
{ schemaVersion: 2, mode, task,
  regions: [{ file, language, startLine, endLine, content,
              chunks: [{ id, name?, kind, startLine, endLine, relevance?, score, reason, supportFor?,
                         signals?, origin? }] }],
  warnings, skipped: [{ chunkId, file, startLine, endLine, name?, relevance?, score }],
  retrievalConfigVersion?, jevQuestionVersion?, decisionsReusedFrom?,
  jev?: { requestCount?, latencyMs, usage: { inputTokens, outputTokens },
          requests?: [{ latencyMs, inputTokens, outputTokens }] },
  explain? }
```

Source content appears once, on the region; chunk entries carry provenance only. `relevance` is absent in `no-jev`
mode, and so is `jevQuestionVersion` (an additive field; `schemaVersion` stays 2). `signals` and `origin` on a chunk,
and the top-level `explain`, appear only with `--explain`.

`decisionsReusedFrom` (ISO 8601 UTC, additive; `schemaVersion` stays 2) is present only when the run reused a stored Jev
decision instead of asking Jev (identical task, candidates and versions; see docs/cache-design.md). Such a run has no
`jev` block, since no request was made.

`jev` reports Jev's external-service overhead, separately from the selected context. It is present only when Jev was
called and reported usage (absent with `--no-jev` and when there were no candidates to judge). `latencyMs` is the wall
clock of the whole Jev decision in milliseconds; requests run concurrently, so it is not the sum of the per-request
latencies. `usage` is the input and output token counts as reported by Jev, summed over every request. `requestCount`
is the number of requests sent, and `requests` (`--explain` only) lists each request's own latency and tokens in
request order. No monetary cost is reported because pricing is not verified. Additive; `schemaVersion` stays 2.

### schemaVersion

`schemaVersion` is `2`. Version 2 removed the token budget and every size field of version 1 (`budget`, `estimator`,
`estimatedTokens`, `characters`, `lines`, per-chunk and per-skip `estimatedTokens`, `unmetCoherence`, and the skip
`reason` and `minimumBudget`). It is bumped on any breaking change: removing or renaming a key, changing a key's type or
meaning, or narrowing an enum. Adding an optional key is not breaking but must be added to the schema in the same
change. Consumers should reject a `schemaVersion` they do not know.
