import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ChunkKind, CodeChunk, Language, Reference, ReferenceEvidence, SourceLocation } from "../types.ts";
import { entryMac, macEquals, statMac, type StatFields } from "./integrity.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import { canReuseOnRename, retargetAnalysis } from "./rename.ts";
import type { CommitOutcome, DocumentType } from "./store.ts";

/** What `analyzeFile` produced for one file, as the loader needs it. */
export interface CachedAnalysis {
  chunks: CodeChunk[];
  warnings: string[];
  textOnly: boolean;
}

interface Entry extends CachedAnalysis {
  path: string;
  /** HMAC of the entry key and the rest of the entry under the user's integrity key. */
  mac: string;
}

interface Shard {
  entries: Record<string, Entry>;
}

const SHARD_PREFIX = "analysis-";
const SHARD_NAME = /^analysis-[0-9a-f]{2}$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Hex SHA-256 of `path`, a NUL, then the raw file bytes. The path is part of the key because chunk IDs, `file` fields
 * and the language depend on it. The raw bytes are the whole input: redaction and classification are deterministic
 * functions of bytes and path, and the analyzer fingerprint in the version keys covers the code that does them.
 */
export function analysisKey(path: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`${path}\0`).update(bytes).digest("hex");
}

/** Hex SHA-256 of the raw bytes alone: the same content at any path, for rename detection. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A file is trusted by its stat only when its modification time is at least this much older than the moment the
 * record was taken. Inside the margin a later edit could keep the same size and modification time (filesystems tick
 * coarsely), so the file is read and hashed instead. Git's "racily clean" rule.
 */
export const RACY_MARGIN_MS = 2000;

/** The fields of `fs.stat` that identify a file's state (`bigint: false`; sub-millisecond parts are fractions). */
export interface StatInfo {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/** Clock and margin seams; the defaults are the real clock and {@link RACY_MARGIN_MS}. */
export interface RefreshOptions {
  now?: () => number;
  racyMarginMs?: number;
}

interface StatRecord extends StatFields {
  /** HMAC over the version keys, the path and the other fields under the user's integrity key. */
  mac: string;
}

interface FilesDocument {
  files: Record<string, StatRecord>;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStatRecord = (value: unknown): value is StatRecord =>
  isObject(value) &&
  onlyKeys(value, ["size", "mtimeMs", "ctimeMs", "ino", "key", "hash", "recordedAt", "mac"]) &&
  isNumber(value.size) &&
  Number.isInteger(value.size) &&
  value.size >= 0 &&
  isNumber(value.mtimeMs) &&
  isNumber(value.ctimeMs) &&
  isNumber(value.ino) &&
  isNumber(value.recordedAt) &&
  isString(value.key) &&
  KEY_PATTERN.test(value.key) &&
  isString(value.hash) &&
  KEY_PATTERN.test(value.hash) &&
  isString(value.mac) &&
  KEY_PATTERN.test(value.mac);

/** Strict shape check of the `files` document payload. Repository contents are untrusted. */
export function isFilesDocument(payload: unknown): payload is FilesDocument {
  return (
    isObject(payload) &&
    onlyKeys(payload, ["files"]) &&
    isObject(payload.files) &&
    Object.values(payload.files).every(isStatRecord)
  );
}

const filesType: DocumentType<FilesDocument> = { name: "files", schemaVersion: 1, validate: isFilesDocument };

const shardName = (key: string) => `${SHARD_PREFIX}${key.slice(0, 2)}`;

// Why shards: one document per file would mean up to 10,000 fsync'd writes on a cold run, and one document for
// everything would rewrite the whole cache whenever a single file changes. The first two hex characters of the key
// give at most 256 documents, so a cold run writes at most 256 and a one-file change rewrites one.

// `satisfies Record<…, true>` makes the compiler reject a value list that misses a member of the type, so a new
// language or kind cannot make every stored shard fail validation.
const LANGUAGES: ReadonlySet<string> = new Set(
  Object.keys({
    typescript: true,
    javascript: true,
    python: true,
    go: true,
    java: true,
    rust: true,
    sql: true,
    html: true,
    css: true,
    scss: true,
    json: true,
    yaml: true,
    toml: true,
    markdown: true,
    text: true,
  } satisfies Record<Language, true>),
);
const KINDS: ReadonlySet<string> = new Set(
  Object.keys({
    function: true,
    method: true,
    class: true,
    interface: true,
    type: true,
    component: true,
    query: true,
    table: true,
    style: true,
    template: true,
    config: true,
    section: true,
    file: true,
  } satisfies Record<ChunkKind, true>),
);
const REFERENCE_KINDS: ReadonlySet<string> = new Set(
  Object.keys({
    import: true,
    call: true,
    type: true,
    extends: true,
    implements: true,
    style: true,
    test: true,
  } satisfies Record<Reference["kind"], true>),
);
const EVIDENCE: ReadonlySet<string> = new Set(
  Object.keys({ exact: true, heuristic: true, unresolved: true } satisfies Record<ReferenceEvidence, true>),
);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isLine = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
/** The object has no keys beyond `allowed`; a planted document cannot smuggle extra fields into chunks. */
const onlyKeys = (value: Obj, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const optional = (value: Obj, key: string, check: (v: unknown) => boolean) => !(key in value) || check(value[key]);

const isLocation = (value: unknown, file: string): value is SourceLocation =>
  isObject(value) && onlyKeys(value, ["file", "line"]) && value.file === file && isLine(value.line);

const REFERENCE_KEYS = Object.keys({
  kind: true,
  from: true,
  name: true,
  specifier: true,
  local: true,
  namespace: true,
  targetChunkId: true,
  evidence: true,
} satisfies Record<keyof Reference, true>);

const isReference = (value: unknown, file: string): value is Reference =>
  isObject(value) &&
  onlyKeys(value, REFERENCE_KEYS) &&
  isString(value.kind) &&
  REFERENCE_KINDS.has(value.kind) &&
  isLocation(value.from, file) &&
  isString(value.name) &&
  optional(value, "specifier", isString) &&
  optional(value, "local", isString) &&
  optional(value, "namespace", (v) => v === true) &&
  optional(value, "targetChunkId", isString) &&
  optional(value, "evidence", (v) => isString(v) && EVIDENCE.has(v));

const CHUNK_KEYS = Object.keys({
  id: true,
  file: true,
  language: true,
  kind: true,
  name: true,
  startLine: true,
  endLine: true,
  content: true,
  references: true,
  parentId: true,
  containerName: true,
} satisfies Record<keyof CodeChunk, true>);

const isChunk = (value: unknown, file: string): value is CodeChunk =>
  isObject(value) &&
  onlyKeys(value, CHUNK_KEYS) &&
  isString(value.id) &&
  value.file === file &&
  isString(value.language) &&
  LANGUAGES.has(value.language) &&
  isString(value.kind) &&
  KINDS.has(value.kind) &&
  optional(value, "name", isString) &&
  isLine(value.startLine) &&
  isLine(value.endLine) &&
  value.endLine >= value.startLine &&
  isString(value.content) &&
  Array.isArray(value.references) &&
  value.references.every((reference) => isReference(reference, file)) &&
  optional(value, "parentId", isString) &&
  optional(value, "containerName", isString);

const isEntry = (value: unknown): value is Entry =>
  isObject(value) &&
  onlyKeys(value, ["path", "chunks", "warnings", "textOnly", "mac"]) &&
  isString(value.path) &&
  Array.isArray(value.chunks) &&
  value.chunks.every((chunk) => isChunk(chunk, value.path as string)) &&
  Array.isArray(value.warnings) &&
  value.warnings.every(isString) &&
  typeof value.textOnly === "boolean" &&
  isString(value.mac) &&
  KEY_PATTERN.test(value.mac);

/** Strict shape check of a shard payload (everything but `schemaVersion`). Repository contents are untrusted. */
export function isShard(payload: unknown, name?: string): payload is Shard {
  if (!isObject(payload) || !onlyKeys(payload, ["entries"]) || !isObject(payload.entries)) return false;
  return Object.entries(payload.entries).every(
    ([key, entry]) => KEY_PATTERN.test(key) && (name === undefined || shardName(key) === name) && isEntry(entry),
  );
}

const shardType = (name: string): DocumentType<Shard> => ({
  name,
  schemaVersion: 2,
  validate: (payload): payload is Shard => isShard(payload, name),
});

/**
 * Per-file analysis results stored in the repository cache, reused when the same path has the same bytes.
 * Only files that reached `analyzeFile` are stored (binary and language-less files are cheap to skip; excluded files
 * are never read). A commit keeps exactly the entries this run used, so deleted and changed files are pruned and the
 * cache holds the latest scan only.
 */
export class AnalysisCache {
  readonly #cache: RepositoryCache;
  readonly #warnings: string[] = [];
  readonly #shards = new Map<string, Promise<Shard | undefined>>();
  /** Every entry this run used, whether it was a hit or newly recorded. */
  readonly #used = new Map<string, Entry>();
  /** Keys recorded this run. A record only happens on a miss, so a stored entry under such a key is stale or absent. */
  readonly #recorded = new Set<string>();
  /** The stat records to store: one per file that reached analysis this run, whether kept or new. */
  readonly #seen = new Map<string, StatRecord>();
  readonly #now: () => number;
  readonly #margin: number;
  #stored: Promise<FilesDocument | undefined> | undefined;
  #byHash: Map<string, string[]> | undefined;

  constructor(cache: RepositoryCache, warnings: readonly string[] = [], options: RefreshOptions = {}) {
    this.#cache = cache;
    this.#now = options.now ?? Date.now;
    this.#margin = options.racyMarginMs ?? RACY_MARGIN_MS;
    for (const warning of warnings) this.#warn(warning);
  }

  /** The clock this cache stamps stat records with. Read it before statting a file. */
  now(): number {
    return this.#now();
  }

  /** Cache problems met so far. Each can arise at most once per run (shard reads are memoized). They never fail a run. */
  get warnings(): string[] {
    return [...this.#warnings];
  }

  #warn(warning: string) {
    this.#warnings.push(warning);
  }

  #shard(name: string): Promise<Shard | undefined> {
    let shard = this.#shards.get(name);
    if (!shard) {
      shard = this.#cache.store.read(shardType(name)).then(({ value, warning }) => {
        if (warning) this.#warn(warning);
        return value;
      });
      this.#shards.set(name, shard);
    }
    return shard;
  }

  /** The entry stored under `key` when it is for `path` and its MAC verifies; undefined otherwise. */
  async #verified(path: string, key: string): Promise<Entry | undefined> {
    if (this.#cache.fresh) return undefined;
    const shard = await this.#shard(shardName(key));
    const entry = shard !== undefined && Object.hasOwn(shard.entries, key) ? shard.entries[key] : undefined;
    if (
      !entry ||
      entry.path !== path ||
      !macEquals(entry.mac, entryMac(this.#cache.integrityKey, this.#cache.keys, key, entry))
    )
      return undefined;
    return entry;
  }

  /**
   * The stored analysis for this path and key, or undefined. A fresh cache never reads: every lookup misses. A hit
   * needs the entry's path to match and its MAC to verify under this user's key and this entry key, so a planted or
   * cloned entry (the repository is untrusted) is a miss.
   */
  async lookup(path: string, key: string): Promise<CachedAnalysis | undefined> {
    const entry = await this.#verified(path, key);
    if (!entry) return undefined;
    this.#used.set(key, entry);
    return { chunks: entry.chunks, warnings: entry.warnings, textOnly: entry.textOnly };
  }

  /** The stored stat records, read once; undefined when missing or unusable (the store warns) or the cache is fresh. */
  #records(): Promise<FilesDocument | undefined> {
    this.#stored ??= this.#cache.fresh
      ? Promise.resolve(undefined)
      : this.#cache.store.read(filesType).then(({ value, warning }) => {
          if (warning) this.#warn(warning);
          return value;
        });
    return this.#stored;
  }

  /** The stored record for `path` when its MAC verifies under this user's key and the current version keys. */
  async #trusted(path: string): Promise<StatRecord | undefined> {
    const files = (await this.#records())?.files;
    const record = files !== undefined && Object.hasOwn(files, path) ? files[path] : undefined;
    if (!record) return undefined;
    return macEquals(record.mac, statMac(this.#cache.integrityKey, this.#cache.keys, path, record))
      ? record
      : undefined;
  }

  #sign(path: string, fields: StatFields): StatRecord {
    return { ...fields, mac: statMac(this.#cache.integrityKey, this.#cache.keys, path, fields) };
  }

  /**
   * The stat fast path: the stored analysis of a file whose stat is unchanged, without reading it. Needs a record
   * whose MAC verifies, equal size, modification time, change time and inode, a modification time at least the racy
   * margin older than the record, and a verified analysis entry for the record's key. Anything else is undefined, and
   * the caller reads and hashes the file, which decides.
   */
  async fast(path: string, info: StatInfo): Promise<CachedAnalysis | undefined> {
    const record = await this.#trusted(path);
    if (
      !record ||
      record.size !== info.size ||
      record.mtimeMs !== info.mtimeMs ||
      record.ctimeMs !== info.ctimeMs ||
      record.ino !== info.ino ||
      record.recordedAt - info.mtimeMs < this.#margin
    )
      return undefined;
    const analysis = await this.lookup(path, record.key);
    if (analysis) this.#seen.set(path, record);
    return analysis;
  }

  /**
   * Notes the stat record of a file that was read and hashed (so not a fast hit), taken at `statAt`, the clock before
   * the file was statted. A file still inside the racy margin keeps its previous record when that describes the same
   * state, so a warm run changes nothing; a record taken once the margin has passed replaces it, and the file
   * becomes a fast hit from the next run.
   */
  async note(path: string, info: StatInfo, key: string, hash: string, statAt: number): Promise<void> {
    const previous = await this.#trusted(path);
    const same =
      previous !== undefined &&
      previous.size === info.size &&
      previous.mtimeMs === info.mtimeMs &&
      previous.ctimeMs === info.ctimeMs &&
      previous.ino === info.ino &&
      previous.key === key &&
      previous.hash === hash;
    if (same && statAt - info.mtimeMs < this.#margin) this.#seen.set(path, previous);
    else this.#seen.set(path, this.#sign(path, { ...info, key, hash, recordedAt: statAt }));
  }

  /**
   * The stored analysis of identical bytes recorded under another path, rewritten for `path`, and recorded under
   * `key`. Needs the same non-empty extension and classification (see `canReuseOnRename`), a stat record and an
   * analysis entry that both verify. The old entry is not marked used, so it is pruned unless its file still exists.
   */
  async renamed(path: string, key: string, hash: string, head: string): Promise<CachedAnalysis | undefined> {
    const files = (await this.#records())?.files;
    if (!files) return undefined;
    if (!this.#byHash) {
      this.#byHash = new Map();
      for (const oldPath of Object.keys(files).sort()) {
        const list = this.#byHash.get(files[oldPath]!.hash) ?? [];
        list.push(oldPath);
        this.#byHash.set(files[oldPath]!.hash, list);
      }
    }
    for (const oldPath of this.#byHash.get(hash) ?? []) {
      if (oldPath === path || !canReuseOnRename(oldPath, path, head)) continue;
      const record = await this.#trusted(oldPath);
      const entry = record && record.hash === hash ? await this.#verified(oldPath, record.key) : undefined;
      if (!entry) continue;
      const analysis = retargetAnalysis(entry, oldPath, path);
      this.record(path, key, analysis);
      return analysis;
    }
    return undefined;
  }

  /** Notes a result to store at commit. */
  record(path: string, key: string, analysis: CachedAnalysis): void {
    const entry = { path, chunks: analysis.chunks, warnings: analysis.warnings, textOnly: analysis.textOnly };
    this.#used.set(key, { ...entry, mac: entryMac(this.#cache.integrityKey, this.#cache.keys, key, entry) });
    this.#recorded.add(key);
  }

  /** Whether the store would change: new results, a stale entry or unusable shard that was read, or an unread shard. */
  async #needsCommit(): Promise<boolean> {
    if (this.#cache.fresh || this.#recorded.size > 0) return true;
    const stored = await this.#records();
    const desired = Object.fromEntries(this.#seen);
    if (stored === undefined ? this.#seen.size > 0 : !isDeepStrictEqual(stored.files, desired)) return true;
    for (const pending of this.#shards.values()) {
      const shard = await pending;
      if (!shard) return true;
      for (const key of Object.keys(shard.entries)) if (!this.#used.has(key)) return true;
    }
    // A shard on disk that no lookup touched holds none of this run's keys, so all of it is stale.
    try {
      const names = (await readdir(this.#cache.directory)).filter((file) => file.startsWith(SHARD_PREFIX));
      return names.some((file) => !this.#shards.has(file.slice(0, -".json".length)));
    } catch {
      return false;
    }
  }

  /** Writes the entries this run used and prunes every other one. Does nothing, taking no lock, when nothing changed. */
  async commit(): Promise<CommitOutcome | undefined> {
    if (!(await this.#needsCommit())) return undefined;
    const wanted = new Map<string, Map<string, Entry>>();
    for (const [key, entry] of this.#used) {
      const name = shardName(key);
      const keys = wanted.get(name) ?? new Map<string, Entry>();
      keys.set(key, entry);
      wanted.set(name, keys);
    }
    const outcome = await commitRepositoryCache(this.#cache, async (tx) => {
      const names = new Set([...(await tx.list()).filter((name) => name.startsWith(SHARD_PREFIX)), ...wanted.keys()]);
      for (const name of names) {
        if (!SHARD_NAME.test(name)) {
          tx.removeName(name);
          continue;
        }
        const desired = wanted.get(name);
        if (!desired) {
          tx.removeName(name);
          continue;
        }
        const type = shardType(name);
        const existing = await tx.read(type);
        const same =
          existing !== undefined &&
          Object.keys(existing.entries).length === desired.size &&
          [...desired.keys()].every((key) => key in existing.entries);
        if (!same || [...desired.keys()].some((key) => this.#recorded.has(key)))
          tx.write(type, { entries: Object.fromEntries(desired) });
      }
      // Stat records are kept for the files of this run only, so deleted and renamed paths drop out.
      const stored = await tx.read(filesType);
      const files = Object.fromEntries(this.#seen);
      if (this.#seen.size === 0) {
        if (stored !== undefined) tx.remove(filesType);
      } else if (stored === undefined || !isDeepStrictEqual(stored.files, files)) tx.write(filesType, { files });
    });
    if (!outcome.committed) this.#warn(outcome.warning);
    return outcome;
  }
}
