# Selection policy

Accepted contract (issue #164, superseding the token-budget policy of issues #51 and #53). The selector
(`src/context/select.ts`) is relevance-only: it has no size limit and no notion of cost.

## What is selected

Scope returns **everything relevant to the task**:

1. **Relevant candidates.** Every candidate whose Jev relevance (or `score` in `--no-jev` mode) is at least
   `MIN_RELEVANCE` (0.5) is included. Nothing is dropped, truncated or summarized because of how much text results.
2. **Supporting declarations.** For each included chunk, the declarations it cannot be read without are added (the
   class or namespace header chain around a method, and the exact `type`, `extends` and `implements` targets; see
   `src/context/coherence.ts`). They are included whatever their relevance and without a cap. A support that is also
   a relevant candidate keeps its own judgment and is not marked as a support.
3. **Merging.** Chunks that touch, overlap or nest are merged into regions so no line is printed twice
   (`src/context/regions.ts`). Output order is by file, start line, then chunk id, independent of input order, so
   repeated runs are byte-identical.

The retrieval shortlist cap (30 candidates sent to Jev, plus at most 5 memory candidates from similar earlier tasks)
is the only bound, and it applies before judgment, not to the result. A chunk is never cut mid-statement: a parser-free truncation could mislead the reader, and a caller that wants
less can filter the structured JSON output.

## Why there is no budget

A token budget forced Scope to guess a model's tokenizer, to measure its own output (including the size numbers the
output reports about itself) in a fixed-point loop, and to drop relevant code silently-but-reported. The consumer, a
developer or a coding agent, is better placed to decide how much to read. `--budget` was removed; passing it is a usage
error (exit code 2). Scope also reports no size of its own artifact.

## Skipped candidates

`ScopeResult.skipped` lists every judged candidate that scored below the minimum and was not pulled in as a support,
sorted by file, start line, then id, with its location, `name`, `relevance` (absent in `--no-jev` mode) and `score`.
This is expected filtering and is not warned about. Text and Markdown only count these candidates; with `--explain`
every one is listed, most relevant first. JSON always lists them all. A below-threshold chunk that is included as
another chunk's supporting declaration is not reported as skipped.

## Nothing relevant

No relevant chunk is a successful answer, not an error. Retrieval found no candidate, the repository has no analyzable
chunk, or no candidate scored at least the minimum. Scope prints the normal artifact with no chunks or regions
(below-threshold candidates still appear in `skipped` in JSON) and warns `No relevant chunks found...` (plus
retrieval's guidance when it has some) on stderr. Exit code 0. Jev is not called when there is nothing to judge.

## Jev request size

Independent of selection, the Jev adapter bounds each request it sends by serialized characters
(`JEV_BATCH_MAX_CHARS` in `src/config.ts`), splitting the shortlist over several requests when needed. A single
candidate that cannot fit one request together with the task fails the run with a `JevRequestError` that names the
chunk; it is never truncated or silently left out. See [jev-sdk-notes.md](jev-sdk-notes.md).
