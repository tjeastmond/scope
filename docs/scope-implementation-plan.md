# Scope implementation plan

> Scope selects the smallest useful code context for a software task.

Plan date: October 5, 2026. Based on the referenced **Jev Context Optimization** conversation and the subsequent decision to use Jev by default. Defaults and acceptance criteria marked as proposed make the implementation concrete. SDK details must be verified against official documentation when integrating rather than treating the conversation's illustrative API code as executable code.

## Product goal and boundaries

**Scope is a project built around Jev:** it uses Jev to judge which repository chunks are useful for a software task. The first working prototype must exercise the real official SDK end to end. Static retrieval prepares a bounded candidate set; it does not replace the central Jev relevance decision.

Input: a task description and a local repository. Output: a compact, coherent context artifact with source locations, code, and selection evidence for a developer or coding agent.

```bash
scope "Add retry handling to Stripe webhook processing"
```

Scope stops at context selection. It does not solve the task, modify source, generate patches, execute an agent, or run the target repository's tests. Scope's own development tests and evaluation harness are separate from product behavior.

## Architecture decisions

| Area              | Decision                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation    | One Node + TypeScript package; no monorepo.                                                                                                                              |
| Development tools | Bun for package management and `bun:test`; commit the lockfile.                                                                                                          |
| Runtime           | Compiled CLI runs on Node 24+ without Bun. Verify on Node 24 and Node 26. Avoid Bun-only runtime APIs.                                                                   |
| CLI               | One task argument and a small set of flags; no interactive UI.                                                                                                           |
| Parsing           | Tree-sitter behind a language analyzer interface, with structural parsing and text fallbacks.                                                                            |
| Shared model      | Every analyzer produces normalized `CodeChunk` records.                                                                                                                  |
| Graph             | Approximate local imports, references, styles, and test relationships; preserve uncertainty.                                                                             |
| Retrieval         | Deterministic lexical, symbol, path, and graph retrieval prepares a high-recall, bounded candidate set for Jev.                                                          |
| Jev               | Core relevance decision layer through the official `@typesafe-ai/sdk`, integrated in the first milestone and used by default.                                            |
| Selection         | Jev relevance decides what is relevant; TypeScript adds supporting declarations, merges overlapping ranges, and orders output deterministically. There is no size limit. |
| Size              | None. Scope returns everything relevant (issue #164 removed the token budget and all token estimation).                                                                  |
| Output            | Text, Markdown, and versioned JSON, with optional explanations.                                                                                                          |
| Persistence       | In-memory analysis for the first prototype; late V1 milestone adds repository-local chunk caching and retrieval memory with incremental updates.                         |

**Static analysis discovers structure. Jev judges relevance. TypeScript makes the final selection.**

```text
Task + repository
  → scan and classify
  → language analyzers → normalized chunks + approximate repository graph
  → deterministic retrieval + bounded relationship expansion
  → candidate shortlist (initial target: 20–30 chunks)
  → Jev relevance judgments (bypassed with --no-jev)
  → relevance selection (everything at or above the minimum, plus supporting declarations)
  → context compiler → text / Markdown / JSON
```

Suggested source modules: `repository/`, `analyzers/`, `graph/`, `retrieval/`, `jev/`, `context/`, `output/`, plus `cli.ts`, `scope.ts`, and `types.ts`. Keep orchestration callable independently of argument parsing.

## CLI contract

```bash
scope "<task>" [--repo <path>]
      [--format text|markdown|json] [--output <path>] [--no-jev] [--explain] [--no-cache]

scope cache status  [--repo <path>] [--format text|json]
scope cache clear   [--repo <path>] --yes
scope cache rebuild [--repo <path>]
```

- Default repository: current working directory.
- Default format: text, including source locations and code snippets.
- There is no size budget: Scope returns every relevant chunk (`--budget` is an unknown option, exit 2).
- Default mode: deterministic candidate retrieval followed by Jev reranking; requires Jev credentials and network access.
- Default destination: stdout; diagnostics go to stderr so JSON remains parseable.
- `--output` writes the selected context artifact; it does not edit repository source.
- The ordinary command sends shortlisted source context to TypeSafe/Jev. Document this default behavior and credential setup.
- `--no-jev` is an explicit diagnostic/benchmark baseline, running deterministic-only selection without credentials or network access. It is not the primary product path.
- `--no-cache` (or `SCOPE_CACHE=off`) runs without reading or writing the local analysis cache in `.scope/`; the CLI uses the cache by default.
- `scope cache status|clear|rebuild` inspect and control the local store (#80). A subcommand is recognised only when `cache` is the first argument (`scope -- cache` runs a task named "cache"). They need no task, Jev or credentials. `status` is read-only; `clear` requires `--yes` (no interactive prompt), refuses symlinked `.scope/` or store directories and deletes only Scope's files inside `.scope/`; `rebuild` reanalyzes everything and rewrites analysis data only (usage error under `SCOPE_CACHE=off`).
- Default execution fails clearly if Jev cannot complete; it does not silently substitute deterministic results. A user can explicitly rerun with `--no-jev`.
- Reject empty tasks, invalid formats, and inaccessible repositories with actionable errors.

## Core data contracts

```ts
interface CodeChunk {
  id: string;
  file: string; // repository-relative normalized path
  language: Language;
  kind:
    | "function"
    | "method"
    | "class"
    | "interface"
    | "type"
    | "component"
    | "query"
    | "table"
    | "style"
    | "template"
    | "config"
    | "section"
    | "file";
  name?: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  content: string;
  references: Reference[];
}
```

Define `Language` and `Reference` alongside the model. References should record relationship kind, source location, optional resolved target, and resolution evidence. Use stable chunk IDs for unchanged source; handle duplicate names using file and range identity.

Keep retrieval scores and selection reasons separate from source records. A result should include schema version (2), task, selected chunks, merged regions, warnings, skipped candidates, and mode. Each selected chunk carries deterministic signal breakdown, optional Jev relevance, final score, and inclusion reason. Scores are ranking signals; do not present combined scores as calibrated probabilities.

## Milestone 1 — Working Jev-powered vertical slice

**Outcome:** `scope "<task>" --repo <fixture>` calls Jev through the official SDK and returns source chunks selected using its relevance judgments.

- [ ] Bootstrap one Node + TypeScript package with Bun tooling and a compiled Node CLI.
- [ ] Verify official `@typesafe-ai/sdk` authentication, Noul schema, question/state behavior, response mapping, usage fields, and request limits.
- [ ] Define the minimal `CodeChunk` and decision-provider contracts; create one small TypeScript fixture with relevant and irrelevant functions.
- [ ] Extract that fixture's chunks with Tree-sitter; defer broad language and graph coverage until the end-to-end path works.
- [ ] Use a small bounded candidate list, initially all eligible fixture chunks, to isolate Jev behavior from retrieval quality.
- [ ] Send the task and candidate IDs, paths, symbols, and code; ask one atomic usefulness question per candidate with an explicit candidate reference.
- [ ] Map validated Jev answers back to chunks and use their relevance as the selection utility.
- [ ] Add relevance selection and text output with exact source locations.
- [ ] Provide credential setup guidance and clear failures; never turn a failed Jev call into an apparently successful default run.
- [ ] Add fake-provider tests for ordinary CI and run a small opt-in real SDK contract test before accepting the milestone.
- [ ] Record actual relevance judgments, selected context, request latency, and returned usage in the prototype evidence.

**Acceptance:** a real Jev request influences the returned context on the fixture, and the compiled command runs under Node. Fake responses alone do not satisfy this milestone. If credentials are unavailable, report the live verification as blocked rather than declaring the integration complete.

## Milestone 2 — Repository scanning and multi-language parsing

**Outcome:** the Jev-powered pipeline accepts real repositories and normalized chunks across the planned languages.

- [ ] Create one TypeScript package, Bun lockfile, build scripts, linting, formatting, and type checking.
- [ ] Configure `engines.node` for Node 24+ and a `scope` binary pointing to compiled JavaScript with a Node shebang.
- [ ] Implement task and flag parsing; Commander is an optional small dependency.
- [ ] Resolve repository roots and produce stable repository-relative paths.
- [ ] Respect `.gitignore`; exclude dependency folders, build artifacts, VCS internals, binary files, and common secret files.
- [ ] Set file-size and traversal limits; avoid symlink loops and escaping the repository root.
- [ ] Classify languages and file types, with explicit reasons for skipped files.
- [ ] Add real scan fixtures for ignored files, nested directories, unreadable files, and mixed file types.
- [ ] Verify a packaged CLI invocation under Node, separately from Bun tests.

- [ ] Define `CodeChunk`, analyzer interfaces, reference records, and line-range conventions.
- [ ] Validate Tree-sitter bindings and grammar installation on the supported Node versions; pin compatible versions.
- [ ] Implement semantic extraction for TypeScript, JavaScript, TSX, JSX, and Python.
- [ ] Extract functions, methods, classes, types/interfaces where applicable, components, imports, exports, and practical references.
- [ ] Implement structural extraction for SQL, HTML, CSS/SCSS, JSON, YAML, TOML, and Markdown.
- [ ] Extract SQL statements/CTEs/tables/views, markup regions, style blocks, configuration sections, and Markdown heading sections.
- [ ] Add bounded text fallback for unsupported languages and partially malformed files; record fallback warnings.
- [ ] Preserve useful declaration context while avoiding uncontrolled overlap between classes and methods.
- [ ] Build a mixed application fixture spanning frontend, backend, Python workers, SQL, styles, configuration, and tests.
- [ ] Assert extraction against actual parsers, including Unicode, CRLF, nested symbols, duplicate names, and syntax errors.

**Acceptance:** fixture inventories and source ranges are correct and stable; unsupported or malformed files have explicit fallbacks; the existing Jev path consumes the normalized chunks; scanning leaves source unchanged; the built CLI runs on Node 24 and 26 without Bun.

## Milestone 3 — Candidate preparation and repository graph

**Outcome:** a high-recall, bounded shortlist that lets Jev judge useful context without sending the entire repository.

- [ ] Build indexes for chunk names, paths, and source text.
- [ ] Normalize task terms and identifier variants, including camelCase and snake_case.
- [ ] Implement symbol, lexical, and path scoring with separately inspectable contributions.
- [ ] Build approximate local import/reference relationships and test-to-source associations.
- [ ] Resolve straightforward relative imports; document alias and dynamic-reference limitations.
- [ ] Expand strong matches by one dependency hop with caps on fan-out and candidate count.
- [ ] Add graph distance, related tests, and module proximity to ranking; treat expanded neighbors as candidates rather than automatic inclusions.
- [ ] Deduplicate candidates and define stable tie-breaking by path, range, and ID.
- [ ] Keep weights in one versioned configuration; begin with illustrative symbol/lexical/path/dependency/test/proximity weights of 0.30/0.20/0.15/0.20/0.10/0.05 (proximity is a small same-directory bonus for chunks near the best match), then tune from evaluations.
- [ ] Add initial labeled tasks now so later milestones can measure changes. Git relevance is optional and should wait unless evaluation justifies it.

**Acceptance:** representative fixture tasks expose required symbols and supporting context to Jev; candidate recall is measured separately from final selection recall; identical inputs produce identical candidate ordering; cyclic and high-fan-out graphs remain bounded.

## Milestone 4 — Context compiler, formats, and explanations

**Outcome:** usable Jev-powered context artifacts in all output formats with inspectable decisions.

- [ ] Select every candidate Jev judges relevant (at or above the minimum), plus a small explicit coherence policy for supporting declarations and dependencies. Use deterministic signals for candidate preparation and stable tie-breaking; evaluate any score blending before adopting it.
- [ ] Merge or deduplicate overlapping ranges so no line is printed twice.
- [ ] Include complete chunks whole; nothing is truncated or dropped for size.
- [ ] Compile text, Markdown, and versioned JSON with paths, inclusive line ranges, names, languages, scores, and source content.
- [ ] Report skipped (below-threshold) candidates.
- [ ] Implement `--output` and `--explain`, including scoring evidence, dependency distance, and reasons for exclusions.
- [ ] Report an empty result (nothing relevant) as a successful run with a warning.
- [ ] Verify escaping, arbitrary source content, JSON validity, stdout/stderr separation, and output-file behavior.

**History:** this milestone originally included a token budget, a pluggable token estimator, cost-ranked selection, and an insufficient-budget error. TJ removed all of it in issue #164 (see [selection-policy.md](selection-policy.md)): the consumer decides how much to read, and Scope no longer guesses a tokenizer.

**Acceptance:** all three formats are usable and traceable to original source; explanations account for selection decisions; repeated offline results are stable.

## Milestone 5 — Jev reliability and operational hardening

**Outcome:** the Jev integration established in milestone 1 handles realistic repository sizes and service failures reliably.

- [ ] Verify the official `@typesafe-ai/sdk` authentication, Noul question schema, batching limits, response mapping, retries, timeout/cancellation support, and usage fields.
- [ ] Harden the existing official SDK adapter and decision-provider interface; do not build a custom transport layer.
- [ ] Send only the task and bounded shortlisted candidates with IDs, paths, symbols, and code.
- [ ] Ask one atomic Noul relevance question per candidate, explicitly identifying the candidate in the question/state. Do not rely on question-map keys being transmitted.
- [ ] Bound batch size and request payload by serialized characters; map responses back to candidate IDs and validate finite values in the expected range.
- [ ] Preserve Jev relevance as the primary utility signal. Evaluate relevance thresholds on labeled tasks; adopt deterministic score blending only if held-out evidence supports it.
- [ ] Handle missing credentials, timeout, rate limits, malformed/partial responses, and service errors with explicit failures after bounded SDK retries. Show setup or retry guidance and the explicit `--no-jev` baseline alternative; do not automatically downgrade the default product path.
- [ ] Use SDK retry behavior without stacking an independent retry loop; verify the total time bound.
- [ ] Capture returned usage and request latency where available; keep API keys out of artifacts and logs.
- [ ] Use a fake provider for normal tests and a tiny opt-in live contract suite for SDK/API behavior.

**Acceptance:** default operation invokes Jev with configured credentials; failures are visible and never silently downgraded; `--no-jev` never contacts Jev or requires credentials; fake-provider tests cover success and failures; live tests verify candidate identification, response mapping, batching, and usage; a single candidate too large for one request fails clearly.

## Milestone 6 — Persistent chunk cache and retrieval memory

**Outcome:** Scope remembers code it has already analyzed, refreshes that knowledge as the local repository changes, and uses prior retrieval experience to find relevant context faster for Jev.

This is how Scope improves with use: it accumulates a current structural map and evidence about useful context. Jev remains the relevance decision layer. Memory updates Scope's local data and retrieval behavior; they do not retrain Jev or autonomously rewrite Scope's implementation.

```text
First task → parse source → cache chunks and relationships → Jev review → record selection
Later task → validate cached source fingerprints → refresh changed files
           → retrieve from cached index and prior task associations
           → Jev reviews current candidates → relevance-selected output → update memory
```

- [ ] Add a repository-scoped, versioned local store for file fingerprints, normalized chunks, relationships, lexical indexes, and retrieval history. SQLite is a candidate implementation; choose a Node 24-compatible storage approach after a small compatibility check.
- [ ] Put generated data in a documented ignored local directory, proposed `.scope/`; partition by repository identity and store schema, parser, and grammar versions.
- [ ] Authenticate cached analysis entries with an HMAC under a random per-user key stored outside the project at `$XDG_STATE_HOME/scope/cache-key` (default `~/.local/state/scope/cache-key`, mode 0600), so a planted or cloned `.scope/` is a miss. It is the one file Scope writes outside the repository; it is never printed, and deleting it only costs a cold run.
- [ ] Cache source-derived chunks after analysis, including IDs, content fingerprints, names, ranges, and references. Derive the initial warm index from real source rather than prior task selections alone.
- [ ] On each run, detect new, changed, renamed, and deleted files, including uncommitted changes. Reparse affected files and refresh impacted relationships; remove stale entries and recompute line ranges from current source.
- [ ] Reuse parsing and indexing for unchanged files. Invalidate affected cache data when parser, grammar, or ignore rules change.
- [ ] Record task-to-chunk associations, Jev relevance judgments, selection decisions, and bounded request metadata with source fingerprints and decision configuration provenance.
- [ ] Use related prior tasks, recurring symbols, and confirmed useful relationships as additional candidate discovery signals. Combine history with fresh retrieval so unfamiliar tasks and new files remain discoverable.
- [ ] Keep source-analysis reuse separate from decision reuse: similar tasks still receive fresh Jev review. Reuse a completed decision only for an exact matching task, candidate payload, source fingerprints, SDK/model configuration, and question version under a documented expiry policy.
- [ ] Provide a simple feedback mechanism for users or consuming agents to mark selected chunks useful, missing, or irrelevant. Treat agent feedback as attributed observations; validate referenced chunks against current source.
- [ ] Distinguish feedback from Scope's own predictions. Repeated selection or a high Jev score alone is not proof of usefulness; do not amplify it as confirmed success.
- [ ] Version any adaptive retrieval weights, bound their influence, and evaluate proposed changes against held-out tasks before promotion. Preserve a baseline and rollback path.
- [ ] Include cache hits, refreshed files, reused decisions, memory-assisted candidate reasons, and feedback provenance in explanations and JSON metadata.
- [ ] Add cache inspection, clearing, and forced-rebuild controls; bound history size and retention. Never persist API keys. Cache corruption must trigger a safe rebuild rather than stale output.
- [ ] Test cold versus warm equivalence for source inventories, edit/rename/delete invalidation, branch switches, version changes, interrupted writes, concurrent runs, repository isolation, and explicit cache clearing.
- [ ] Benchmark repeated identical tasks, related tasks, and unseen tasks for parsing time, candidate recall, end-to-end latency, and Jev usage. Report measured improvements rather than assuming memory helps.

**Acceptance:** unchanged code is reused without reparsing; changed code produces current content and exact ranges; deleted code never appears from stale memory; the default path still uses Jev or a disclosed exact decision-cache hit; history does not suppress discovery of unseen code; warm-run speedups and feedback-driven retrieval changes have benchmark evidence without unacceptable quality regressions.

## Milestone 7 — Benchmark harness, evaluation, and release

**Outcome:** reproducible evidence of retrieval quality, context savings, and Jev's incremental value.

- [ ] Expand to 3–5 representative fixture repositories and 20–30 human-labeled tasks across supported languages.
- [ ] Label required, useful, and irrelevant chunks using stable symbol/range identities; define coverage matching for merged or split ranges.
- [ ] Separate tuning tasks from held-out evaluation tasks; freeze labels before comparing modes.
- [ ] Implement `bun run eval` with machine-readable results and a generated Markdown report.
- [ ] Compare a simple lexical baseline, deterministic Scope, and Scope + Jev at identical repository snapshots.
- [ ] Measure required-context recall, precision, irrelevant-context rate, context size relative to the eligible repository, and latency.
- [ ] Use the same eligible scanned source for the full-repository baseline; disclose scan exclusions.
- [ ] Report Jev input/output usage separately from selected-context size. Include combined token consumption and price-based cost only where current pricing and usage are known.
- [ ] Repeat live Jev evaluations to show variability; record SDK/model identifiers where available, versions, scoring configuration, fixture revision, and timestamps.
- [ ] Compare cold and warm runs and memory enabled versus disabled; isolate parsing savings, exact decision reuse, and feedback-assisted candidate improvements. Keep held-out labels and test answers out of retrieval memory.
- [ ] Publish per-task results and aggregates, including regressions and cases where Jev provides no improvement.
- [ ] Set proposed release gates: zero deterministic output drift on fixed inputs; establish recall/precision thresholds after baseline measurement and before final tuning.
- [ ] Add CI for installation, build, type checking, linting, formatting, Bun tests, offline evaluation, and Node 24/26 packaged CLI smoke tests.
- [ ] Document installation, examples, supported languages, fallback limitations, Jev source transmission, and benchmark reproduction.
- [ ] Verify scoped npm package naming before publishing; retain `scope` as the CLI name. `@tjeastmond/scope` is a proposed package name, not a verified reservation.

**Acceptance:** offline CI needs no API key; benchmark results are reproducible from recorded inputs; Jev comparisons report quality, variability, latency, and usage honestly; a packed install works on both Node runtime targets.

## Evaluation metric definitions

| Metric                  | Definition                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Required recall         | Covered required labeled context units / total required units.                                                   |
| Precision               | Selected required or useful labeled units / selected units, using the declared matching policy.                  |
| Irrelevant-context rate | Selected source characters labeled irrelevant / selected source characters. Report unlabeled context separately. |
| Size reduction          | `1 - selected source characters / eligible repository characters`; specify whether output overhead is included.  |
| Jev impact              | Paired quality and context-size differences on the same task.                                                    |
| Jev overhead            | Additional request latency and API usage; monetary cost only when verified.                                      |

Do not trade required recall for impressive size reduction without showing both.

## Testing strategy

- **Unit:** scanner policies, classification, extraction/ranges, reference resolution, lexical scoring, bounded graph traversal, deterministic tie-breaking, selection, serialization, and provider response validation.
- **Integration:** real Tree-sitter parsing of mixed fixtures through the complete pipeline with a fake decision provider in CI; no parser mocks. Include malformed source, unknown languages, empty repositories, oversized chunks, cycles, and very large chunks.
- **Runtime/package:** execute built and packed CLI artifacts with Node 24 and 26. Bun test success alone does not prove Node compatibility or native parser installation.
- **Golden evaluation:** human-labeled context expectations and stable offline reports. Introduce fixtures during milestones 2–3, then complete the harness in milestone 7.
- **Cache and memory:** incremental invalidation, cold/warm source equivalence, decision-cache provenance, feedback attribution, rollback, and isolation between repositories and evaluation splits.
- **Live contract:** explicit opt-in Jev suite using credentials; never part of ordinary PR CI. Required for milestone 1 integration acceptance and V1 release evidence. Keep it small and record usage.
- **Read-only behavior:** ensure selection does not modify source files or execute repository code.

## V1 exclusions

- Code implementation, patch generation, automatic source modification, task-solving LLM calls, autonomous agent loops, and target-repository test execution.
- Embeddings, vector databases, and full compiler-grade cross-language analysis. Repository-local persistent caching and retrieval memory are included in milestone 6.
- Jev model training and autonomous rewriting of Scope's implementation. Improvement in V1 means incremental indexing and evidence-backed retrieval adaptation.
- MCP server, IDE plugin, web UI, interactive terminal UI, daemon, and watch mode.
- Conversation compaction, agent execution integrations, and automatic implementation workflows.
- Any size budget, token estimation, or cost-aware (knapsack) selection (removed in issue #164).

## Delivery sequence and definition of done

Start with milestone 1 to prove the real Jev-powered flow. Milestones 2–3 improve the source context and candidate supply feeding that flow. Milestone 4 completes the context artifact, milestone 5 hardens the existing integration, milestone 6 adds incremental caching and retrieval memory, and milestone 7 measures quality and prepares release. Introduce labeled tasks early. Offline baseline evaluations explicitly use `--no-jev`; default-path CI tests use a fake provider, while real SDK evidence remains required for integration acceptance.

V1 is complete when a user can install the Node CLI, configure Jev credentials, provide a task and repository, and obtain a traceable Jev-reranked context artifact containing everything relevant to the task by default; `--no-jev` provides offline selection without credentials; Jev reranking has tested failure handling; persistent chunk memory stays current as source changes; and the evaluation report exposes quality, cold/warm performance, savings, and external-service overhead. No implementation or execution of the user's requested code change belongs in this release.
