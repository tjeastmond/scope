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
  `{ schemaVersion: 2, entries: { [key]: { path, chunks, warnings, textOnly, mac } } }`.
- **What is stored.** Only files that reached `analyzeFile` (files with a language): the chunks exactly as analysis
  returned them from the redacted source, the analyzer's warnings, and the text-only flag. Binary files and files with
  no language are not stored (their check is cheap and they have no analysis). Excluded files (ignored, secret, too
  large) are never read, so they never get here.
- **Untrusted content.** `.scope/` lives in the project, which is untrusted: a planted or cloned cache must be a miss.
  A strict validator checks every field of every chunk, reference and location, that each chunk's `file` equals its
  entry's `path`, that each key belongs to its shard, and that each entry has a `mac`. One bad entry makes the whole
  shard unusable: the store warns once and the shard is treated as empty, so those files are reanalyzed. A lookup then
  requires the entry's `path` to equal the path being loaded and its `mac` to verify (HMAC-SHA256, constant-time
  comparison) under this user's integrity key over the current version keys, the entry key and the whole entry. Content,
  names, references, warnings or chunks changed after signing, an entry moved to another key, and an entry signed under
  older version keys (replayed after `meta.json`, which is not signed, is rewritten) fail the check. Checking content against
  the source cannot be made complete, so Scope does not try. Any mismatch is a miss: the file is analyzed again and the
  commit replaces the entry.
- **Pruning.** A commit keeps exactly the entries this run used (hits and newly analyzed), rewrites a shard only when
  its key set changed, and removes shards that end up empty. Deleted and changed files drop out, so the cache holds the
  latest scan only. When the version keys changed (a fresh cache), nothing is read and the old shards are removed.
- **No-op warm runs.** When the cache is not fresh, nothing was analyzed, and no shard on disk holds a key this run did
  not use, the commit is skipped: no lock and no write, not even `meta.json`.
- **Reading.** #70 alone reads and hashes every file on a warm run; #71 skips the read when the stat matches (below).
- Cache problems (open, read and commit warnings) never fail a run; they are added to the run's warnings, each once.
  Output is identical with the cache cold, warm or off, apart from those warnings.
- The cache is off for library callers (`ScopeOptions.cache`, default `false`); the CLI turns it on by default.

**Built in #71** (`src/cache/analysis.ts`, `src/cache/rename.ts`, wired into `loadChunks`):

- **The `files` document** (schemaVersion 1, strict validator) maps each path to
  `{ size, mtimeMs, ctimeMs, ino, key, hash, recordedAt, mac }`. `key` is the #70 analysis key of the bytes last read at
  that path, `hash` is `sha256(bytes)` (content only, used for rename reuse), and `recordedAt` is the time just before
  the file was stat'ed and read. Only files that reached `analyzeFile` or hit an analysis entry get a record; binary and
  language-less files are still read every run. Stats use `stat` (not `lstat`) with millisecond values, which are
  fractional on APFS and ext4.
- **Stat MAC.** `mac` is an HMAC under the integrity key over the version keys, the tag `"files"`, the path and every
  other field. Its shape (ten elements, the second a string) can never equal the entry MAC's shape, so neither verifies
  as the other. A planted, edited or replayed record (another user's key, older version keys, an entry MAC) is a miss.
- **Fast path.** A file is not read when the cache is not fresh, its record's MAC verifies, `size`, `mtimeMs`, `ctimeMs`
  and `ino` all match, the racy guard passes, and the analysis entry for `key` exists under that path and verifies.
  It counts as `reused` and as a `statHits`. Anything else is read and hashed, and the hash decides.
- **Racy guard.** A record is trusted only when `recordedAt - max(mtimeMs, ctimeMs) >= RACY_MARGIN_MS` (2000 ms), as in
  git's index: a file modified within the margin of the recording could be edited again without its times changing.
  ctime counts too, because an edit that restores an old mtime still lands in the current ctime tick. Such a record is
  kept as is while the file is still racy, so a no-change run writes nothing; once the file has aged, the next run
  re-hashes it once and records it as trusted.
- **Residual risk.** `touch -d`, `cp -p` and `rsync -t` can restore size and mtime but not ctime, which is why ctime and
  `ino` are compared. An edit that keeps the size and happens within the same ctime tick as the recording is caught by the
  racy margin, which is measured from the newer of mtime and ctime. A tool that sets ctime (restoring the clock, or writing the inode directly) defeats the check;
  that needs write access to the repository, which already allows planting any source.
- **Commit.** The `files` document keeps only paths seen in this run (so deleted files drop out and retention is
  bounded). It is written only when its content changes, removed when no path is left, and the no-op short-circuit
  (no lock, no write) still applies to warm runs with no change.
- **Rename reuse.** A file whose `sha256(bytes)` matches a verified stat record under another path reuses that
  analysis, rewritten for the new path, when both paths have the same non-empty lowercase extension and
  `classifyFile` gives the same language and strategy for both. Extensionless files (classified by name or shebang) never
  use it. The rewrite sets `file` on every chunk and `from.file` on every reference, recomputes every chunk `id` with
  `makeChunkId`, remaps `parentId` and `targetChunkId` to the new ids, and replaces the `<old path>: ` prefix of every
  warning. `tests/rename-equivalence.test.ts` proves the result equals a cold analysis at the new path for every
  analyzable fixture, all of `src/` and synthetic sources of each language; no file type is excluded. A `.ts` to `.tsx`
  rename is never reused because the grammar depends on `.tsx`. The result is recorded under its new key and counts as
  `reused` and `renamed`.
- **Bulk changes** (a branch switch: edits, adds, deletes, renames and swaps) converge in one run to the uncached
  result, because every file is decided independently by its own hash and the commit keeps only what this run used. The
  next run is all stat hits (once the files are past the racy margin).

**Built in #72** (`tests/cache-invalidation.test.ts`; no source change was needed):

- **Parse counter.** Reuse is proven by counting real Tree-sitter parses (a spy on `Parser.prototype.parse`), not just
  `analysis.analyzed`. A cold run parses, a no-change warm run parses 0 times, an edited file costs exactly the parses
  of analyzing that file alone with the cache off, and a rename parses 0 times.
- **Version keys.** Each field (`store`, `scope`, `analyzer`, `treeSitter`, each grammar entry, and an added grammar
  entry) invalidates alone: shards and stat records are all rebuilt (`reused`, `statHits` and `renamed` are 0), the
  output equals an uncached run, every MAC on disk verifies under the new keys, and the next run is all stat hits.
  Stat records signed under the old keys never verify, so a rename across a version change is analyzed, not reused.
  Documents from another version are discarded without being read, so damage in them is not reported.
- **Ignore rules.** The scan is never cached: every run applies the current `.gitignore` files (root, nested, directory
  rules). A newly ignored file leaves the output, its analysis entry and its stat record at the next commit; unignoring
  it analyzes it again, and the output always equals an uncached run. `.scope/` is never scanned.
- **Corruption.** Each document (`meta`, `files`, each shard) is validated on its own. A broken one is rebuilt from
  source with exactly one warning and never produces stale output (a damaged `files` document makes every file be read
  and hashed, so a same-size edit with a restored mtime still shows); the next run repairs it. A damaged `meta.json`
  makes the cache fresh. A `.<name>.<hex>.tmp` leftover is never read, and a commit sweeps it once it is older than
  `TMP_MAX_AGE_MS`. A shard replaced by a symlink is not followed (`O_NOFOLLOW`). A shard replaced by a directory is
  reported and never read; since a rename cannot replace a directory, the cache then stays unwritten (one `cache not
written` warning per run) until the directory is removed. A deleted store directory is just a fresh run.
- There are no token estimates: the token budget and all estimation were removed in #164, so nothing size-related is
  cached, and no token estimator version is part of the version keys.
- Relationships are not cached separately: references are part of each chunk, and the repository graph is rebuilt
  from the current chunks on every run (it is cheap and depends on every file, so caching it would only add
  invalidation risk). The warm index is always derived from current source, never from prior task selections.
- Every reuse must equal a cold analysis of the same bytes. The cold-versus-warm equivalence tests prove it.

### Integrity key

Entries are signed with a random per-user key kept outside every project, so a cloned or planted `.scope/` (built
under another key, or by hand) verifies as nothing.

- **Location.** `$XDG_STATE_HOME/scope/cache-key` when `XDG_STATE_HOME` is set to an absolute path (relative values are
  ignored); otherwise `$HOME/.local/state/scope/cache-key`. With neither usable the cache is disabled with a warning.
- **Creation.** On first use Scope creates the directory (mode 0700) and the file (mode 0600, exclusive create) holding
  32 random bytes as 64 lowercase hex characters, then fsyncs it. If the file already exists it is read, never replaced.
- **Checks on every load.** It must be a regular file (not a symlink), owned by the current user, with no group or
  other permission bits, and its trimmed contents must be exactly 64 hex characters. A failing file disables the cache
  with a `cache disabled:` warning that names the path and the reason; it is never overwritten or deleted.
- **Never printed.** The key is not logged or put in any warning, output or stored document.
- **Deleting it** only costs a cold run: every entry then fails verification and is reanalyzed and re-signed.
- It is the only file Scope writes outside the project.

## Retrieval memory (#73, #74, #75, #76 and #77 and #78 implemented)

- **History** (#73, `src/cache/history.ts`) records one document per run, `history-<runId>`, where `runId` is the run's
  finish time as 13 zero-padded decimal digits, `-`, and 8 random hex characters (so names sort by time). The store
  holds `{ record, mac }`; `mac` is an HMAC-SHA256 of the record and the repository's real root under the integrity key, and
  `readHistory` skips a record whose MAC, shape or id (it must match the document name) fails, and any `history-*`
  name Scope never writes, so a planted or cloned `.scope/`, or history copied from another repository, contributes
  no history. A record holds: record version, run id, time, the redacted task (credential shapes and the configured `TYPESAFE_API_KEY` value removed; cut to 4,000 characters, with a
  `truncated` flag) and its normalized terms (each list capped at 200 terms of at most 200 characters), mode, the
  decision configuration (Scope version, installed SDK version, model, question version, retrieval config version),
  bounded request metadata (latency, request count, token totals, only valid non-negative integers) and the
  candidates (at most 1,000, selected chunks first): chunk id, file, kind, name, a SHA-256 fingerprint of the chunk
  content (the content itself is not stored), origin, Jev relevance (kept for a support Jev judged) and the decision (`selected`, `support` or
  `skipped`, with `supportFor` for supports).
- **When a run records.** Only when the cache is on, the mode is `jev` and Jev judged candidates. `--no-jev` runs, runs
  with no candidates, cancelled runs and `previewJevPayload` record nothing: they carry no Jev judgment to learn from,
  and diagnostic baselines would evict real history from the bounded store. The record is written in a second commit
  after the selection is built, so it never changes the selection or any output field. If that commit fails the run
  still succeeds and gains one warning, `history not recorded: <reason>`.
- **Pruning** happens in the same commit, by the time in the document name: the newest `SCOPE_HISTORY_MAX_RUNS`
  survive and none older than `SCOPE_HISTORY_MAX_DAYS`. A `history-*` document whose name does not parse was not
  written by Scope and is removed, and so is any document that fails verification (shape, id or MAC), so a
  planted name can never take a retention slot. With either bound at 0 nothing is written and all history is removed.
  `scope cache status` counts the documents by name only (it never loads the integrity key); `rebuild` leaves history
  alone on a current cache and `clear` removes it.
- **Feedback** (#76, `src/cache/feedback.ts`, `src/feedback.ts`) is an attributed observation about the chunks one
  earlier run selected, recorded with `scope feedback <run-id> [--useful <chunk-id>]... [--irrelevant <chunk-id>]...
[--missing <path:start-end|path|symbol>]... [--agent <name>] [--file <path|->]`. It is only recorded and counted:
  nothing in selection, scoring or decision reuse reads it (#77 turns it into evidence, and #74 will consume that),
  and recording it changes no output of a run.
  - **Run id.** A Jev run with the cache on reports the id of its history record (`runId` in JSON, a `Run` line in
    text and Markdown). A decision-reuse hit reports the original run's id (the decision record, version 2, carries an
    optional `runId`; version 1 documents are a miss) only if that run's history record still exists and verifies;
    otherwise the id is omitted, and a reuse never records a new history entry. `--no-jev`, cache-off, empty and cancelled runs have none.
  - **Attribution.** `{ kind: "user" }` by default, `{ kind: "agent", name }` with `--agent` (1 to 100 printable
    characters; a name that is or contains a credential, including the configured Jev key, is refused without being
    echoed). Each record stores its time. List flags are repeat-only (a path can contain a comma).
  - **Validation, all-or-nothing.** The run id must name a verified history record. `--useful` and `--irrelevant` ids
    must be candidates of that run. Each chunk is then compared with the current source (the same scan, ignore and
    exclusion rules as a run): if its id is gone or its content's SHA-256 differs from the run's fingerprint it is
    recorded with `current: false` and a warning, not rejected, so a later reader knows the observation may describe
    other code. Chunk ids are not content-addressed, so every reference also stores the fingerprint of the content it
    was about (#77): for `--useful` and `--irrelevant`, the fingerprint in the run's history record. `--missing` is classified as `path:start-end` (an included file, 1-based inclusive range within its
    line count), else a repository-relative included file (whole file), else a symbol: the exact `name` of at least one
    current chunk. A symbol, a path or a range stores the ids and current content fingerprints of the chunks it resolved to (a path or range: those of the file that overlap it; at most 20), so later readers can tell whether that code has changed. Absolute paths, `..`, symlink escapes and files the scan excludes
    (ignored, binary, secret-like) are rejected without being read. Limits: 200 entries per list, 500 characters per
    entry, at least one entry, no id both useful and irrelevant; duplicates collapse. Any failure records nothing.
  - **Errors.** Bad input, `SCOPE_CACHE=off` and a retention bound of 0 are usage errors (exit 2), as for `scope
cache rebuild`; an unavailable cache or a failed commit is a failure (exit 1).
  - **Storage.** One document per submission, `feedback-<feedbackId>` (same id shape as a run id, so names sort by
    time), holding `{ record, mac }` (record version 3, which adds fingerprints and, for paths and ranges, the covered chunks; #76 and #77 had merged the
    same day, so earlier versions needed no migration, and a version 1 or 2 document is skipped by `readFeedback` and
    pruned at the next write like any unverified document). The MAC is an HMAC under the integrity key, bound to the repository root with
    the domain `feedback`; `readFeedback` returns verified records newest first and skips (with a warning) anything
    unreadable, malformed, renamed or signed by another key or root. Pruning is in the same commit as the write, by
    name time: newest `SCOPE_FEEDBACK_MAX`, none older than `SCOPE_FEEDBACK_MAX_DAYS`; unverified documents take no
    slot. Feedback stands alone: it survives its run's history being pruned.
  - **Never stored.** Source code, the task text, raw Jev responses, environment variables or keys. A record holds ids,
    paths, line ranges, symbol names, fingerprints and booleans.
- **Evidence classes are kept apart** (#77, `src/cache/evidence.ts`). `collectEvidence` turns the bounded history and
  feedback into a per-chunk summary with three classes in separate fields, so no code can mistake one for another:
  - **Predictions** come from history candidates' `decision`: counts of `selected`, `support` and `skipped`. This is
    Scope's own output.
  - **Jev judgments** come from history candidates' `relevance`: how many runs judged the chunk, and the mean and
    maximum relevance. This is a model's opinion.
  - **External feedback** comes from feedback records: counts of `useful`, `irrelevant` and `missing` (a symbol
    `--missing` counts once for each chunk it lists, as does a path or range, each only while that chunk's content is
    unchanged), the time of the latest feedback and the number of distinct
    sources (the user, and each agent name). Path-level `--missing` entries are also kept separately as locations, for
    files that are still included.
  - **Fingerprint validation.** Ids are not content-addressed, so an observation counts only when its chunk id exists
    now and its recorded fingerprint equals the current content fingerprint. Deleted or edited code carries no
    evidence; the dropped observations are only counted (`stale`). Feedback given with `current: false` (the code had
    already changed) never counts either.
  - **Confirmation.** `isConfirmedUseful` takes only the feedback counts and is true when `useful + missing >
irrelevant`; `isConfirmedIrrelevant` is true when `irrelevant > useful + missing`. A tie is neither. Predictions
    and Jev scores never confirm usefulness and must not be amplified into it: repeated selection or a high Jev
    score alone is not proof.
  - **Scope.** The summary is deterministic regardless of input order and adds no storage; `loadEvidence` reads and
    validates it against the current chunks. Retrieval memory (#74) builds on the same rules.
- **Memory signals** (#74, `src/cache/memory.ts`) add a few labeled candidates from similar prior tasks. They only
  add: the fresh shortlist is computed exactly as without history and stays whole and in order, so unfamiliar tasks and
  new files remain as discoverable as before, and memory candidates are appended after it.
  - **Similar tasks.** The task's terms (`extractTaskTerms` after the same credential redaction history applies, the
    `exact` and `words` terms lowercased as one set) are compared with each history record's stored terms by Jaccard
    similarity (shared terms over all terms). A record is similar at `memory.similarityMin` (0.3) or more; an identical
    task scores 1. Only the newest `memory.maxRuns` (20) similar records of other tasks count, and separately the newest 20 runs of the identical task (for their feedback only), so repeating a task never pushes the related runs that shaped its shortlist out of the window.
  - **Sources, strongest first.** (a) chunks named by `--missing` feedback on a similar run (a symbol, or a file or range;
    only the chunks the feedback listed, and only while their content is unchanged); (b) chunks confirmed useful by external feedback; (c) chunks Jev selected in a similar
    run. Within a source: higher similarity first, then file, start line and id. Confirmed-irrelevant chunks (#77) are
    never added, and neither is a chunk already in the fresh shortlist. At most `memory.maxCandidates` (5) are added.
  - **Validation.** A remembered chunk must exist in the current scan with the content fingerprint it was recorded
    with, so deleted or edited code never returns from memory. Predictions and Jev judgments are not confirmation
    (#77): only (a) and (b) earn the full memory signal 1; (c) earns 0.5.
    Only history and feedback within the retention bounds in effect for the run count (age by the run's clock, then
    the newest `maxRuns` or `max`; none when a bound is 0), so expired or disabled data never shapes a shortlist, even
    before the next commit prunes it.
  - **Score and labels.** Memory never changes a fresh candidate's signals, score or origin. A memory candidate gets a
    `memory` signal next to the six retrieval signals (as they were, or 0), and its retrieval total is left as it was:
    memory decides only which chunks are appended and in what order, and Jev's relevance is the score. Its origin is `memory: missing in similar task <runId>` for (a) and
    `memory: similar task <runId>` for (b) and (c); the report shows it as the chunk's source.
  - **Controls.** `SCOPE_MEMORY=off` (any other value or none leaves memory on) turns it off for benchmarks (and `SCOPE_ADAPTIVE=off` the adapted weights);
    `memory.maxCandidates` 0 does too (`src/retrieval/config.ts`). Memory is also off with the cache off, with
    `--no-jev` (a pure deterministic baseline) and for a store that was just reset. In every case the shortlist is
    exactly the memory-free one. Memory reads existing history and feedback and stores nothing;
    `SCOPE_JEV_PAYLOAD=print` shows the same shortlist a run would send, without writing: it only reads an existing
    integrity key (it never creates the key or its directory) and applies no memory when there is none.
  - **Decision reuse.** The decision key covers the final candidate list, so a memory-assisted shortlist has its own
    key. History records of the identical task text do not offer (c) candidates, since that run already judged this
    exact shortlist; this keeps an identical repeat with unchanged code on the same key and a reuse hit. History keeps
    only the first 4,000 characters of a task, so a task is treated as identical only when neither it nor the record was
    truncated. Two long tasks that share that prefix are then related, not identical; the cost is that a long task's
    first repeat gets a fresh Jev review instead of a reuse hit.
- **Decision reuse** (#75, `src/cache/decisions.ts`) is separate from analysis reuse: a similar task always gets a
  fresh Jev review, and a Jev decision is reused only on an exact key match within its expiry.
  - **Key.** `keyId` is HMAC-SHA256, under the integrity key and bound to the repository's real root, of: the exact task
    text; a SHA-256 of the canonical JSON of the exact request payload (`planJevRequests`, which includes the model);
    each candidate's id and a SHA-256 of its full content, in candidate order (the payload truncates long candidates);
    the installed SDK version, model, question version, retrieval config version and Scope version. The key is keyed
    so that the document names do not let anyone who can read `.scope/` test guesses of a task's text.
  - **Storage.** One document per decision, `decision-<13-digit time>-<keyId>`, holding `{ record, mac }` with
    `record = { recordVersion, keyId, time, judgments: [{ chunkId, relevance }] }` (the validated relevance of each
    candidate, in candidate order). The task text, source code, raw Jev answers, usage and environment are never stored.
  - **Provider identity.** The key includes the provider's own payload identity (`DecisionProvider.decisionCacheKey`:
    the request payload built with that provider's own limits, hashed). The default Jev adapter's identity is computed
    without a client or credentials, so a hit never needs either. An injected provider without `decisionCacheKey` is
    never cached: it neither reads nor writes decisions, and a different identity (a fake, or an adapter with other
    limits) never shares a key with the default adapter.
  - **Lookup.** A run looks up a decision when the cache is on and opened, the mode is `jev`, there are candidates,
    `--fresh` is not given and the decision bounds are not 0. It lists names, keeps those ending in `-<keyId>`
    within the expiry and reads the newest. The document must have a valid strict shape, the key id and time of its
    name, a valid MAC (same domain-tagged construction as history, bound to the root), a time not in the future, and
    judgments covering exactly the current candidates. Anything else, including a corrupt or planted document, is a
    miss and Jev is asked. On a hit the provider is never constructed (no credentials needed) and selection runs as for
    a fresh decision, so the selected chunks, regions and skipped entries equal those of the original run.
  - **Expiry and retention.** A decision older than `SCOPE_DECISIONS_MAX_DAYS` (default 7 days) is never reused. After
    a fresh decision the same commit that writes it prunes: names that do not parse, expired and unverified documents,
    older documents of the same key, and everything beyond the newest `SCOPE_DECISIONS_MAX` (default 500) are removed;
    a document takes a retention slot only once verified. With either bound at 0 nothing is looked up or written, and
    that commit removes every decision. Retention warnings are the ones already added once per run.
  - **Disclosure.** `ScopeResult.decisionsReusedFrom` (ISO 8601 UTC time of the stored decision) is set only on a hit.
    JSON carries `decisionsReusedFrom`; text and Markdown always show `Decisions reused from <time> (identical task,
candidates and versions; run with --fresh to ask Jev again)`. A hit has no `jev` metrics block, since no request was
    made, and the per-chunk reason stays `Jev relevance <value>` because it is still Jev's judgment.
  - **`--fresh`** asks Jev again even when a match is stored and caches the new decision, which replaces the older
    one for the same key.
  - **History.** A hit records no run history: the original Jev run is already in history, and recording reused
    decisions would count one Jev judgment twice when memory (#74) learns from history. A `--fresh` run records history as usual.
  - **Failure.** A decision is stored after the selection is built, in its own commit. If that fails the run still
    succeeds and gains one warning, `decision not cached: <reason>`, after the other cache warnings. `--no-jev` runs,
    runs with no candidates, cancelled runs and `previewJevPayload` neither read nor write decisions.
- **Adaptive weights** (#78) are described in the next section.

### Adaptive weights (#78)

Retrieval weights can be adapted within a fixed bound, only after a held-out evaluation, and are always reversible.

- **Baseline.** `DEFAULT_RETRIEVAL_CONFIG.weights` (version `retrieval-v4`) is never stored or edited. Adaptation is
  one multiplier per signal (symbol, lexical, path, dependency, test, proximity), each within 0.8 to 1.2 (a bound of 0.2).
- **Document.** One signed document, `weights-active`: the multipliers, the baseline version they apply to, the held-out
  evaluation that justified them and a MAC under the per-user integrity key. Its version is `adaptive-<12 hex>`, a hash
  of the baseline version and the multipliers. It holds numbers only: no task text, labels or paths.
- **Verification.** A document with a wrong MAC, a multiplier outside the bound, a `baselineVersion` other than the
  current baseline, or one that is unreadable or malformed is ignored with exactly one warning, and the baseline is used.
- **Runtime.** In a Jev run with the cache on, weights become baseline times multiplier and the configuration version
  becomes `<baseline>+<adaptive>` (for example `retrieval-v4+adaptive-0123456789ab`). That version appears in the result,
  in run history and in the decision key, so a decision made under one weight set is never reused under another.
  `SCOPE_ADAPTIVE=off` (any other value leaves it on), `--no-jev`, `--no-cache` and a store that was just reset all use
  the baseline. `SCOPE_JEV_PAYLOAD=print` shows the shortlist the adapted run would send.
- **Proposals.** `proposeWeights` learns only from external feedback (#77): chunks confirmed useful against chunks
  confirmed irrelevant (or, with no irrelevant feedback, the other candidates of the same run), comparing each signal's
  mean under the baseline. Scope's own selections and Jev scores are never evidence. No feedback gives the identity.
- **Gate.** `scripts/adapt-weights.ts` evaluates the baseline and the proposal on the `heldout` split of a labeled
  fixture, with retrieval only (never `runScope`), so held-out task text and labels are never written to history,
  feedback or decisions. A proposal is promoted (with `--promote`) only if held-out recall is strictly higher on the
  same labels over at least one task and it differs from the baseline; otherwise nothing is written and a reason is shown.
- **Rollback.** `scope cache reset-weights` removes only the weights document. `scope cache status` shows the active
  version, or `baseline`; `scope cache clear` removes the document with everything else. Status cannot verify the MAC
  (it never loads the key), so it labels the version unverified.

## Retention bounds

| Data               | Bound                                                     |
| ------------------ | --------------------------------------------------------- |
| Analysis shards    | Files of the latest scan only (so the scan limits apply)  |
| Stat records       | Files of the latest scan only (one `files` document)      |
| Run history        | Newest 200 runs, none older than 90 days (#73)            |
| Reusable decisions | Newest 500, none older than 7 days (#75)                  |
| Feedback           | Newest 2,000 observations, none older than 365 days (#76) |

The history, decision and feedback bounds can be overridden with `SCOPE_HISTORY_MAX_RUNS`, `SCOPE_HISTORY_MAX_DAYS`,
`SCOPE_DECISIONS_MAX`, `SCOPE_DECISIONS_MAX_DAYS`, `SCOPE_FEEDBACK_MAX` and `SCOPE_FEEDBACK_MAX_DAYS` (`src/cache/retention.ts`,
`resolveRetention`). A value must be a non-negative decimal integer, at most 10 times its default; 0 keeps none (the data
type is disabled). An invalid value is ignored with a warning and the default applies. `scope cache status` shows the
bounds in effect. History (#73) is recorded under its bounds and read by memory (#74); decisions (#75) are stored
and reused under theirs; feedback (#76) is recorded under its bounds and read as evidence by #77 and by memory.
`SCOPE_MEMORY=off` turns retrieval memory off (see Memory signals). `SCOPE_ADAPTIVE=off` uses the baseline weights
(see Adaptive weights).

## What a run reports (#79)

With the cache on, the result carries a `cache` block (JSON) and a one-line `cache:` summary (text and Markdown); see
[output-formats.md](output-formats.md) for the fields. It reports the version keys the store is partitioned by, whether
the run started cold, how many files were reused, refreshed and removed (and which were refreshed, capped), and, for Jev
runs, whether a stored decision was reused and when it expires, how many memory candidates were added, and which
adaptive weight set was active. A memory-assisted chunk carries its reason (source, the similar run, similarity and the
feedback behind it, with its sources). Reporting reads what the run already computed and changes no selection, score or
candidate. It never includes source, task text, the integrity key or absolute paths.

## What is never stored

API keys or any environment variable; excluded files; unredacted source; raw Jev responses. Task text is stored after
the same secret redaction applied to source.

## Cache commands (#80)

`src/cache/controls.ts` holds the logic; `main.ts` only parses, calls it and prints.

- `scope cache status` is read-only: it never creates `.scope/`, takes no lock and never loads the integrity key. It
  reads documents through the store's own read path, so a corrupt document is reported as unreadable instead of
  failing the command. `--format json` prints the same fields as an object.
- `scope cache clear --yes` clears every `store-v*` directory with a store commit that removes each document, so it
  waits for the lock like any writer and a concurrent run never sees a half-cleared store. Under that lock it also
  removes leftover data `.tmp` files (they are written only under the lock). Afterwards the store directory is removed
  only if it is empty (`rmdir`). `.scope/` and `.scope/.gitignore` stay. Lock-break claim files and a lock held by
  another run are never removed (a live lock must not be); files Scope did not create are left and warned about.
  `.scope` and each store directory are checked with `lstat` and `realpath` first; a link or non-directory aborts
  before anything is deleted. If the lock cannot be taken the command fails and says nothing was deleted.
- `scope cache rebuild` runs the normal scan with `rebuild: true`: no entry lookup, no stat fast path, no rename reuse,
  then a normal commit. On a current cache it rewrites analysis shards and the `files` document and leaves every other
  document (run history, decisions, feedback) alone, which is why it is not "clear then run". On a stale cache
  (another root, or other version keys) the commit resets the whole store, as on any run: the other documents were
  recorded under that root or those versions, and keeping them under the new `meta` would pass them off as current.
  It is a usage error under `SCOPE_CACHE=off`.
