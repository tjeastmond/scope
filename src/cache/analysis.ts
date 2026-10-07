import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { makeChunkId } from "../chunk-id.ts";
import type { ChunkKind, CodeChunk, Language, Reference, ReferenceEvidence, SourceLocation } from "../types.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import type { CommitOutcome, DocumentType } from "./store.ts";

/** What `analyzeFile` produced for one file, as the loader needs it. */
export interface CachedAnalysis {
  chunks: CodeChunk[];
  warnings: string[];
  textOnly: boolean;
}

interface Entry extends CachedAnalysis {
  path: string;
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
  onlyKeys(value, ["path", "chunks", "warnings", "textOnly"]) &&
  isString(value.path) &&
  Array.isArray(value.chunks) &&
  value.chunks.every((chunk) => isChunk(chunk, value.path as string)) &&
  Array.isArray(value.warnings) &&
  value.warnings.every(isString) &&
  typeof value.textOnly === "boolean";

/** Strict shape check of a shard payload (everything but `schemaVersion`). Repository contents are untrusted. */
export function isShard(payload: unknown, name?: string): payload is Shard {
  if (!isObject(payload) || !onlyKeys(payload, ["entries"]) || !isObject(payload.entries)) return false;
  return Object.entries(payload.entries).every(
    ([key, entry]) => KEY_PATTERN.test(key) && (name === undefined || shardName(key) === name) && isEntry(entry),
  );
}

const shardType = (name: string): DocumentType<Shard> => ({
  name,
  schemaVersion: 1,
  validate: (payload): payload is Shard => isShard(payload, name),
});

/**
 * Whether every chunk is what analysis of this source would hold: its range lies in the source, its content is the
 * exact text of those lines (split on `\n` only, see docs/chunk-model.md), its id is derived from its fields, and a
 * parent is a chunk of the same entry. Reference lines are not checked: file-level references sit outside chunks.
 */
function matchesSource(entry: Entry, redactedSource: string): boolean {
  const lines = redactedSource.split("\n");
  const ids = new Set(entry.chunks.map((chunk) => chunk.id));
  return entry.chunks.every(
    (chunk) =>
      chunk.endLine <= lines.length &&
      chunk.content === lines.slice(chunk.startLine - 1, chunk.endLine).join("\n") &&
      chunk.id === makeChunkId(chunk) &&
      (chunk.parentId === undefined || ids.has(chunk.parentId)),
  );
}

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

  constructor(cache: RepositoryCache, warnings: readonly string[] = []) {
    this.#cache = cache;
    for (const warning of warnings) this.#warn(warning);
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

  /**
   * The stored analysis for this path and key, or undefined. A fresh cache never reads: every lookup misses. A hit is
   * checked against `redactedSource` (the current redacted text of the file), so shape-valid but wrong content is a miss.
   */
  async lookup(path: string, key: string, redactedSource: string): Promise<CachedAnalysis | undefined> {
    if (this.#cache.fresh) return undefined;
    const entry = (await this.#shard(shardName(key)))?.entries[key];
    if (!entry || entry.path !== path || !matchesSource(entry, redactedSource)) return undefined;
    this.#used.set(key, entry);
    return { chunks: entry.chunks, warnings: entry.warnings, textOnly: entry.textOnly };
  }

  /** Notes a result to store at commit. */
  record(path: string, key: string, analysis: CachedAnalysis): void {
    this.#used.set(key, { path, chunks: analysis.chunks, warnings: analysis.warnings, textOnly: analysis.textOnly });
    this.#recorded.add(key);
  }

  /** Whether the store would change: new results, a stale entry or unusable shard that was read, or an unread shard. */
  async #needsCommit(): Promise<boolean> {
    if (this.#cache.fresh || this.#recorded.size > 0) return true;
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
    });
    if (!outcome.committed) this.#warn(outcome.warning);
    return outcome;
  }
}
