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
may be broken (a commit takes milliseconds). Breaking is claimed per lock: a breaker exclusively creates
`.lock.break.<id>.<level>.tmp`, where `id` identifies the stale lock it saw, and only the claimant re-checks that lock
and moves it away. A fresh claim means another breaker is working; a claim older than 30 seconds belongs to a crashed
breaker and the next level is claimed. Claims are never deleted by breakers; the temp sweep removes them. If what a
breaker moved turns out to be a different, live lock (the breaker stalled past the stale threshold), it puts it back,
and every holder checks right before writing that the lock still carries its token, skipping its commit otherwise
(`cache lock lost; this run was not cached`). Scope never signals or inspects other processes, so this is the limit of
a lock file: a breaker that stalls for more than 30 seconds between two system calls can at worst cost one run's
commit, never a mixed or corrupt document, and everything stored is validated against current source anyway.

The store reads only regular files and never follows symlinks, so a FIFO or a link to one reads as unusable rather
than hanging. A run that cannot get the lock within 2 seconds skips its commit and warns (`cache busy; this run was
not cached`); its output is unaffected. Two concurrent runs therefore both produce correct output, and the store holds
one of their commits or a merge of both, never a mix of half-written documents.

## Location and version keys (#69)

- The store lives in `.scope/` at the repository root (the `--repo` path, which is exactly the root; Scope never walks
  up to a git root). The scanner already skips `.scope/` (M2), so cache files are never scanned or sent to Jev.
- On the first commit Scope creates `.scope/.gitignore` containing `*`, only when it is missing, so git ignores the
  directory without Scope ever editing the user's own `.gitignore`. The README tells users this.
- Layout: `.scope/store-v<STORE_MAJOR>/`. There are no partition subdirectories: `.scope/` lives inside the repository,
  so two repositories never share a store. Directories for another store major are left untouched, since an older
  Scope may still use them.
- `meta.json` records the repository's real path (`root`), the version keys and `lastUsed`. It is read on open and
  written on every commit. Opening writes nothing.
- The version keys are: the store major, Scope's package version, the analyzer fingerprint (a SHA-256 over the contents
  of every module that affects analysis: all of `analyzers/`, `chunk-id`, `repository/language` and
  `repository/redact`, so any change to them invalidates without a manual bump), the `web-tree-sitter` package version
  and the package versions of the grammar sources (`tree-sitter-wasms` and `@tree-sitter-grammars/tree-sitter-yaml`).
- The cache is `fresh` when meta is missing or unusable, or when its `root` or any key differs. A copied or moved
  repository has a different real path and so rebuilds; a symlinked path to the same repository does not. A commit
  re-reads `meta` under the lock, since another run may have committed other keys after this one opened; if it is
  stale, every document except `meta` is removed in the same transaction, then the caller's update runs (and reads
  the removals as missing). History, decisions and feedback carry their own provenance and are validated per record instead (#73 onwards).
- Ignore rules are not a version key: the scan is never cached, so a changed `.gitignore` adds and removes files on
  the next run like any other change.
- `.scope/` and the store directory must be real directories: if either is a symlink (repository contents are
  untrusted), the cache is disabled rather than reading, writing or removing through the link.
- Any failure (unresolvable root, unreadable analyzer module, unwritable repository) disables the cache with one
  warning and never fails the run.
- The CLI uses the store by default. `--no-cache` (or `SCOPE_CACHE=off`) runs without reading or writing it.
  `runScope` takes `cache: true` and uses none by default, so library callers and tests never write into
  a repository by accident.

## Source analysis cache (#70, #71, #72)

**Built in #70** (`src/cache/analysis.ts`, wired into `loadChunks`):

- **Key.** `analysisKey(path, bytes)` is the hex SHA-256 of the path, a NUL byte, and the raw file bytes. The path is
  covered because chunk IDs, `file` fields and the language depend on it. The raw bytes are covered because redaction
  and classification are deterministic functions of the bytes and the path; the analyzer fingerprint in the version
  keys covers the code that does them.
- **Shards.** Results live in up to 256 documents named `analysis-<xx>`, where `xx` is the first two hex characters of
  the key. One document per file would mean up to 10,000 fsync'd writes on a cold run; one document for everything
  would rewrite the whole cache when a single file changes. Each shard is
  `{ schemaVersion: 1, entries: { [key]: { path, chunks, warnings, textOnly } } }`.
- **What is stored.** Only files that reached `analyzeFile` (files with a language): the chunks exactly as analysis
  returned them from the redacted source, the analyzer's warnings, and the text-only flag. Binary files and files with
  no language are not stored (their check is cheap and they have no analysis). Excluded files (ignored, secret, too
  large) are never read, so they never get here.
- **Untrusted content.** A strict validator checks every field of every chunk, reference and location, that each
  chunk's `file` equals its entry's `path`, and that each key belongs to its shard. One bad entry makes the whole
  shard unusable: the store warns once and the shard is treated as empty, so those files are reanalyzed. A lookup also
  requires the entry's `path` to equal the path being loaded; a mismatch is a miss.
- **Pruning.** A commit keeps exactly the entries this run used (hits and newly analyzed), rewrites a shard only when
  its key set changed, and removes shards that end up empty. Deleted and changed files drop out, so the cache holds the
  latest scan only. When the version keys changed (a fresh cache), nothing is read and the old shards are removed.
- **No-op warm runs.** When the cache is not fresh, nothing was analyzed, and no shard on disk holds a key this run did
  not use, the commit is skipped: no lock and no write, not even `meta.json`.
- **A warm run still reads and hashes every file.** The saving is parsing, not I/O.
- Cache problems (open, read and commit warnings) never fail a run; they are added to the run's warnings, each once.
  Output is identical with the cache cold, warm or off, apart from those warnings.
- The cache is off for library callers (`ScopeOptions.cache`, default `false`); the CLI turns it on by default.

**Planned** (#71, #72):

- There are no token estimates: the token budget and all estimation were removed in #164, so nothing size-related is
  cached.
- Relationships are not cached separately: references are part of each chunk, and the repository graph is rebuilt
  from the current chunks on every run (it is cheap and depends on every file, so caching it would only add
  invalidation risk). The warm index is always derived from current source, never from prior task selections.
- Stat fast path (#71): an index of size and modification time per file, so a file whose size and modification time
  match, and whose modification time is older than the index entry by a safety margin, keeps its hash without being
  read; anything else is read and hashed, and the hash decides. A file whose hash matches an entry recorded under
  another path (a rename) reuses that analysis with the path rewritten and IDs recomputed, when the extension is the
  same.
- Version reuse and invalidation tests (#72).
- Every reuse must equal a cold analysis of the same bytes. The cold-versus-warm equivalence tests prove it.

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

| Data               | Bound                                                     |
| ------------------ | --------------------------------------------------------- |
| Analysis shards    | Files of the latest scan only (so the scan limits apply)  |
| Run history        | Newest 200 runs, none older than 90 days (#73)            |
| Reusable decisions | Newest 500, none older than 7 days (#75)                  |
| Feedback           | Newest 2,000 observations, none older than 365 days (#76) |

## What is never stored

API keys or any environment variable; excluded files; unredacted source; raw Jev responses. Task text is stored after
the same secret redaction applied to source.
