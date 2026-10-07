# Cache and retrieval memory design (M6)

Scope's persistent store remembers what it already analyzed and what it decided, so later runs reparse only changed
files and can use prior experience to find candidates. Jev remains the relevance decision layer: the store changes
Scope's local data and retrieval, never Jev, and never the target repository's source.

This document records the storage decision (issue #68) and the design the rest of milestone 6 builds on. Sections
marked _planned_ describe accepted design that later issues implement; each issue updates its section when it lands.

## Storage decision (#68)

**Decision: plain JSON documents with atomic replace, in a repository-local directory. No SQLite.**

| Option                   | Node 24 / 26                                                | Bun (`bun test` runs shipped `src/`)            | Verdict  |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------- | -------- |
| `node:sqlite`            | Loads without a flag on 24.19 and 26.10 (release candidate) | `No such built-in module: node:sqlite` (1.3.14) | Rejected |
| Native SQLite module     | Needs a native build per platform and Node ABI              | Separate binding behavior                       | Rejected |
| `bun:sqlite`             | Not available on Node                                       | Works                                           | Rejected |
| JSON files, atomic write | `node:fs` only                                              | `node:fs` only                                  | Chosen   |

Scope's tests run the shipped `src/` modules under Bun, so a store that only works on Node could not be tested by the
ordinary suite, and a native module would add the per-platform install risk M2 avoided by using WASM grammars. The
data is small and per repository (bounded by the scan limits and the retention limits below), is read once per run
and written once per run, and needs no queries beyond key lookup, so a document store is enough.

The spike `scripts/spike-store.mjs` opens a store, writes, reads back, simulates an interrupted write and corrupts a
document, using the compiled `dist/` code on plain Node. Recorded runs:

```text
$ node scripts/spike-store.mjs
node v24.19.0
ok  missing document reads as empty without a warning
ok  commit then read back
ok  interrupted write (partial .tmp) leaves the old document readable
ok  truncated document reads as empty with a warning: files.json: not valid JSON (truncated or corrupt); rebuilding
ok  next commit rewrites the document
spike passed

$ node scripts/spike-store.mjs
node v26.10.0
ok  missing document reads as empty without a warning
ok  commit then read back
ok  interrupted write (partial .tmp) leaves the old document readable
ok  truncated document reads as empty with a warning: files.json: not valid JSON (truncated or corrupt); rebuilding
ok  next commit rewrites the document
spike passed
```

### Documents and atomic writes

- A document is one JSON file holding `{ "schemaVersion": <n>, ...payload }`. A reader validates the shape; anything
  else (a missing file, a parse error, a truncated file, an unknown or newer `schemaVersion`, a failed shape check) is
  treated as **empty**, with one warning for a document that existed but was unusable. Scope then rebuilds from
  source: corruption costs a cold run, never stale or wrong output.
- Writes go to a temporary file in the same directory (exclusive create, random name ending `.tmp`), are flushed with
  `fsync`, and are renamed over the target. A reader therefore sees the old document or the complete new one, and an
  interrupted run leaves at most a stray `.tmp` file, which a later commit removes once it is older than a minute.
- Schema migrations are explicit: each document type has a current `schemaVersion` and an optional migration from
  older versions. With no migration, an older version is discarded and rebuilt. Incompatible layout changes bump the
  store's major version, which is part of its directory name (below), so an older Scope never reads a newer layout.

### Concurrency

Reads take no lock. A run gathers what it wants to persist and commits it in one short critical section at the end:
take the store lock, re-read the documents it updates, merge, write each one atomically, release. The lock is a file
created with exclusive create (`O_EXCL`) holding a random token and the time. A lock older than 30 seconds is stale and
may be broken (a commit takes milliseconds). Breaking is serialized by a guard file (`lock.break`, also `O_EXCL`):
only its holder may remove a stale lock, and only after re-reading it and finding it unchanged, so a live lock taken
in the meantime is never removed. A guard older than 30 seconds is itself stale. Scope never signals or inspects other processes. A run that cannot get
the lock within 2 seconds skips its commit and warns (`cache busy; this run was not cached`); its output is
unaffected. Two concurrent runs therefore both produce correct output, and the store holds one of their commits or a
merge of both, never a mix of half-written documents.

## Location, partitioning and version keys (#69, _planned_)

- The store lives in `.scope/` at the repository root (the `--repo` path, which is exactly the root; Scope never walks
  up to a git root). The scanner already skips `.scope/` (M2), so cache files are never scanned or sent to Jev.
- On first write Scope creates `.scope/.gitignore` containing `*`, so git ignores the directory without Scope ever
  editing the user's own `.gitignore`. The README tells users this.
- Layout: `.scope/store-v<major>/<partition>/`, where `<partition>` is the first 16 hex digits of the SHA-256 of the
  repository's real path. A copied or moved repository gets a new partition; two repositories never share one.
  Partitions not used for 30 days are removed on the next commit.
- `meta.json` in each partition records the repository root and the version keys: store schema, Scope's package
  version, the analyzer fingerprint (a SHA-256 over the source of every module that affects analysis: `analyzers/`,
  `chunk-id`, `repository/language` and `repository/redact`, so any change to them invalidates without a manual
  bump), the `web-tree-sitter` version and the grammar package versions. When any key differs, the source-analysis
  data of the partition is discarded and rebuilt; history, decisions and feedback carry their own provenance and are
  validated per record instead.
- Ignore rules are not a version key: the scan is never cached, so a changed `.gitignore` adds and removes files on
  the next run like any other change.
- The CLI uses the store by default. `--no-cache` (or `SCOPE_CACHE=off`) runs without reading or writing it. An
  unwritable repository directory gives one warning and an uncached run. `runScope` takes the store as an option and
  uses none by default, so library callers and tests never write into a repository by accident.

## Source analysis cache (#70, #71, #72, _planned_)

- Per scanned file the index records the content hash (SHA-256 of the raw bytes), size and modification time; the
  analysis result (chunks with IDs, names, ranges, references, the language and the analyzer's warnings) is stored in
  a content-addressed blob. Chunks are stored after secret redaction, exactly as analysis produced them; excluded files
  (ignored, secret, binary, too large) are never read, so they are never stored.
- There are no token estimates: the token budget and all estimation were removed in #164, so nothing size-related is
  cached.
- Relationships are not cached separately: references are part of each chunk, and the repository graph is rebuilt
  from the current chunks on every run (it is cheap and depends on every file, so caching it would only add
  invalidation risk). The warm index is always derived from current source, never from prior task selections.
- Change detection runs on every scan and does not depend on git: a file whose size and modification time match the
  index, and whose modification time is older than the index entry by a safety margin, keeps its hash without being
  read; anything else is read and hashed, and the hash decides. New and changed files are analyzed, deleted files are
  dropped, and a file whose hash matches a blob recorded under another path (a rename) reuses that analysis with the
  path rewritten and IDs recomputed, when the extension is the same.
- Every reuse must equal a cold analysis of the same bytes. The cold-versus-warm equivalence tests (#81) are the proof.

## Retrieval memory (#73 to #78, _planned_)

- **History** records, per run: run id, time, the redacted task and its normalized terms, mode, each candidate's
  chunk id, file, kind, name and content fingerprint, Jev relevance, the selection decision, bounded request metadata
  (latency, usage) and the decision configuration (SDK version, question version, retrieval config version).
- **Evidence classes are kept apart** (#77): Scope's predictions (selected), Jev's judgments, and external feedback.
  Only external feedback counts as confirmed usefulness; repeated selection or a high Jev score never does.
- **Memory signals** (#74) only add candidates or add a bounded score; they never remove a fresh match, reserved slots
  keep fresh-only candidates discoverable, every remembered chunk is validated against current content fingerprints,
  and memory-found candidates carry an explicit reason.
- **Decision reuse** (#75) is separate from analysis reuse: only an exact match of task text, candidate payload,
  source fingerprints, SDK and model configuration, and question version reuses a Jev decision, within an expiry, and
  the output discloses it.
- **Adaptive weights** (#78) are versioned, bounded around the baseline, promoted only after held-out evaluation, and
  can be reset to the baseline.

## Retention bounds

| Data                  | Bound                                                     |
| --------------------- | --------------------------------------------------------- |
| Analysis index, blobs | Files of the latest scan only (so the scan limits apply)  |
| Run history           | Newest 200 runs, none older than 90 days (#73)            |
| Reusable decisions    | Newest 500, none older than 7 days (#75)                  |
| Feedback              | Newest 2,000 observations, none older than 365 days (#76) |
| Partitions            | Removed after 30 days unused                              |

## What is never stored

API keys or any environment variable; excluded files; unredacted source; raw Jev responses. Task text is stored after
the same secret redaction applied to source.
