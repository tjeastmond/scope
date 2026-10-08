import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { CancelledError, UsageError } from "../errors.ts";
import { resolveRepository } from "../repository/root.ts";
import { loadChunks } from "../scope.ts";
import { SHARD_NAME, filesType, shardType } from "./analysis.ts";
import { DECISION_PREFIX } from "./decisions.ts";
import { FEEDBACK_PREFIX } from "./feedback.ts";
import { HISTORY_PREFIX } from "./history.ts";
import { CACHE_DIR, metaType } from "./location.ts";
import { resolveRetention, type RetentionBounds } from "./retention.ts";
import { BREAK_CLAIM_PREFIX, DATA_TEMP, DocumentStore, LOCK_FILE } from "./store.ts";
import { STORE_MAJOR, currentVersionKeys, type VersionKeys } from "./versions.ts";

/** A cache control command could not do its job (exit 1). Usage mistakes are {@link UsageError}s instead. */
export class CacheControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheControlError";
  }
}

const STORE_DIRECTORY = /^store-v[0-9]+$/;
const DOCUMENT_FILE = /^[a-z][a-z0-9-]*\.json$/;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
/** Human-readable byte count: `812 B`, `12.3 KiB`, `4.0 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

interface Layout {
  /** Real path of the repository root. */
  root: string;
  /** `<root>/.scope`, or undefined when it does not exist. */
  scopeDir: string | undefined;
  /** Names of the `store-v<N>` directories inside it, each verified to be a real directory. */
  stores: string[];
}

/**
 * Finds `.scope` and its store directories without following any link. `.scope` and every `store-v*` entry must be
 * a real directory whose real path is its own path inside the real root; anything else throws, and nothing is touched.
 */
async function inspectLayout(repo: string): Promise<Layout> {
  const root = await realpath(resolveRepository(repo).root);
  const scopeDir = join(root, CACHE_DIR);
  const refuse = (path: string) =>
    new CacheControlError(`${path} is a symbolic link or not a directory; refusing to follow it. Nothing was changed.`);
  const checkDirectory = async (path: string): Promise<boolean> => {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || (await realpath(path)) !== path) throw refuse(path);
    return true;
  };
  if (!(await checkDirectory(scopeDir))) return { root, scopeDir: undefined, stores: [] };
  const stores: string[] = [];
  for (const name of (await readdir(scopeDir)).sort()) {
    if (!STORE_DIRECTORY.test(name)) continue;
    await checkDirectory(join(scopeDir, name)); // exists: it was just listed
    stores.push(name);
  }
  return { root, scopeDir, stores };
}

/** Total size of the regular files directly inside `directory` (lstat; links and subdirectories are not followed). */
async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory)) {
    const info = await lstat(join(directory, entry)).catch(() => undefined);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------
// status

export interface CacheStatus {
  root: string;
  /** `<root>/.scope/store-v<N>` for this Scope's store major. */
  store: string;
  exists: boolean;
  sizeBytes: number;
  size: string;
  documents: {
    total: number;
    /** Documents that exist but could not be read (corrupt, outdated or unexpected shape). */
    unreadable: string[];
    analysisShards: number;
    analysisEntries: number;
    /** Documents named `history-*`, counted by name only: status never loads the integrity key, so it cannot verify them. */
    historyRuns: number;
    /** Documents named `decision-*`, counted by name only (not verified), like `historyRuns`. */
    decisions: number;
    /** Documents named `feedback-*`, counted by name only (not verified), like `historyRuns`. */
    feedback: number;
    /** Entries of the `files` document; 0 when it is missing or unreadable. */
    statRecords: number;
  };
  versions: {
    state: "current" | "stale" | "no metadata";
    /** Which of root, store, scope, analyzer, treeSitter and grammars differ from this Scope's; empty unless stale. */
    differing: string[];
  };
  /** ISO 8601 time of the last cache write, or undefined when never. */
  lastUpdated: string | undefined;
  /** Other `store-v*` directories present (for example from another Scope major). */
  otherStores: { name: string; sizeBytes: number; size: string }[];
  retention: { bounds: RetentionBounds; warnings: string[] };
}

const VERSION_FIELDS = ["store", "scope", "analyzer", "treeSitter", "grammars"] as const;

function differingKeys(recorded: VersionKeys, current: VersionKeys): string[] {
  return VERSION_FIELDS.filter((field) => !isDeepStrictEqual(recorded[field], current[field]));
}

/**
 * Describes the cache of a repository. Read-only: it creates nothing, takes no lock and never loads the integrity
 * key. A symlinked `.scope` or store directory is an error and is not followed.
 */
export async function cacheStatus(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<CacheStatus> {
  const layout = await inspectLayout(repo);
  const retention = resolveRetention(env);
  const name = `store-v${STORE_MAJOR}`;
  const store = join(layout.root, CACHE_DIR, name);
  const status: CacheStatus = {
    root: layout.root,
    store,
    exists: layout.stores.includes(name),
    sizeBytes: 0,
    size: formatBytes(0),
    documents: {
      total: 0,
      unreadable: [],
      analysisShards: 0,
      analysisEntries: 0,
      historyRuns: 0,
      decisions: 0,
      feedback: 0,
      statRecords: 0,
    },
    versions: { state: "no metadata", differing: [] },
    lastUpdated: undefined,
    otherStores: [],
    retention,
  };
  for (const other of layout.stores) {
    if (other === name) continue;
    const sizeBytes = await directoryBytes(join(layout.root, CACHE_DIR, other));
    status.otherStores.push({ name: other, sizeBytes, size: formatBytes(sizeBytes) });
  }
  if (!status.exists) return status;

  status.sizeBytes = await directoryBytes(store);
  status.size = formatBytes(status.sizeBytes);
  const documents = new DocumentStore(store);
  // Any file type: a link, directory or FIFO under a document's name is rejected by the store's read (which never
  // follows links) and so reported as unreadable rather than silently skipped.
  const names = (await readdir(store))
    .filter((entry) => DOCUMENT_FILE.test(entry))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
  status.documents.total = names.length;
  const unreadable = (documentName: string) => status.documents.unreadable.push(documentName);

  const meta = await documents.read(metaType);
  if (meta.warning) unreadable("meta");
  if (meta.value) {
    const current = await currentVersionKeys();
    const differing = [
      ...(meta.value.root === layout.root ? [] : ["root"]),
      ...differingKeys(meta.value.keys, current),
    ];
    status.versions = differing.length === 0 ? { state: "current", differing } : { state: "stale", differing };
    // Valid JSON can still hold a time no Date can represent (for example 1e20); report it instead of throwing.
    const lastUsed = new Date(meta.value.lastUsed);
    if (Number.isNaN(lastUsed.getTime())) unreadable("meta");
    else status.lastUpdated = lastUsed.toISOString();
  }
  status.documents.historyRuns = names.filter((candidate) => candidate.startsWith(HISTORY_PREFIX)).length;
  status.documents.decisions = names.filter((candidate) => candidate.startsWith(DECISION_PREFIX)).length;
  status.documents.feedback = names.filter((candidate) => candidate.startsWith(FEEDBACK_PREFIX)).length;
  if (names.includes(filesType.name)) {
    const files = await documents.read(filesType);
    if (files.warning) unreadable(filesType.name);
    status.documents.statRecords = files.value ? Object.keys(files.value.files).length : 0;
  }
  for (const documentName of names.filter((candidate) => SHARD_NAME.test(candidate))) {
    status.documents.analysisShards++;
    const shard = await documents.read(shardType(documentName));
    if (shard.warning) unreadable(documentName);
    status.documents.analysisEntries += shard.value ? Object.keys(shard.value.entries).length : 0;
  }
  return status;
}

/** The text form of {@link cacheStatus}. */
export function formatStatus(status: CacheStatus): string {
  const lines = [
    `Scope cache for ${status.root}`,
    `  store:         ${status.store} (${status.exists ? "present" : "not present"})`,
  ];
  if (status.exists) {
    const { documents, versions } = status;
    lines.push(
      `  size:          ${status.size} (${status.sizeBytes} bytes)`,
      `  documents:     ${documents.total}${documents.unreadable.length > 0 ? `, unreadable: ${documents.unreadable.join(", ")}` : ""}`,
      `  analysis:      ${documents.analysisEntries} entries in ${documents.analysisShards} shards`,
      `  stat records:  ${documents.statRecords}`,
      `  history runs:  ${documents.historyRuns}`,
      `  decisions:     ${documents.decisions}`,
      `  feedback:      ${documents.feedback}`,
      `  versions:      ${versions.state === "stale" ? `stale: ${versions.differing.join(", ")} differ` : versions.state}`,
      `  last updated:  ${status.lastUpdated ?? "never"}`,
    );
  }
  for (const other of status.otherStores) lines.push(`  other store:   ${other.name} (${other.size})`);
  const { bounds } = status.retention;
  lines.push(
    "  retention:",
    `    history      ${bounds.history.maxRuns} runs, ${bounds.history.maxDays} days`,
    `    decisions    ${bounds.decisions.max} entries, ${bounds.decisions.maxDays} days`,
    `    feedback     ${bounds.feedback.max} observations, ${bounds.feedback.maxDays} days`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// clear

export interface ClearResult {
  /** Store directories that were cleared, with what was removed from each. */
  stores: { name: string; documents: number; tempFiles: number; bytes: number }[];
  /** Files left in place under `.scope/`, with why. Warn about each. */
  left: { path: string; reason: string }[];
  /** True when there was no `.scope/` store directory at all. */
  nothingToClear: boolean;
}

/**
 * Deletes the Scope store data under `<root>/.scope/` and nothing else. Every `store-v*` directory is cleared by a
 * store commit (so it respects the lock and a concurrent run never sees a half-cleared store) that removes every
 * document and every leftover data `.tmp` file, and the directory is then removed only if it is empty. `.scope/` and
 * its `.gitignore` stay. Files Scope did not create are left in place. A symlinked `.scope` or store directory is
 * refused before anything is deleted. The integrity key lives outside the repository and is never touched.
 */
export async function clearCache(repo: string, options: { lockWaitMs?: number } = {}): Promise<ClearResult> {
  const layout = await inspectLayout(repo);
  const result: ClearResult = { stores: [], left: [], nothingToClear: layout.stores.length === 0 };
  if (layout.scopeDir === undefined) return result;
  for (const name of layout.stores) {
    const directory = join(layout.scopeDir, name);
    const counts = { documents: 0, tempFiles: 0, bytes: 0 };
    const store = new DocumentStore(directory, {
      lockWaitMs: options.lockWaitMs,
      verifyDirectory: async () => {
        if ((await realpath(directory)) !== directory) {
          throw new Error(`${directory} is not a directory (symlinks are not followed)`);
        }
      },
    });
    const outcome = await store.commit(async (tx) => {
      for (const documentName of await tx.list()) {
        const info = await lstat(join(directory, `${documentName}.json`)).catch(() => undefined);
        counts.documents++;
        counts.bytes += info?.size ?? 0;
        tx.removeName(documentName);
      }
      // Data temp files are only written while holding the lock, which we hold now, so any present are leftovers.
      for (const entry of await readdir(directory)) {
        if (!DATA_TEMP.test(entry)) continue;
        const info = await lstat(join(directory, entry)).catch(() => undefined);
        if (!info?.isFile()) continue;
        await rm(join(directory, entry), { force: true });
        counts.tempFiles++;
        counts.bytes += info.size;
      }
    });
    if (!outcome.committed) {
      const cleared = result.stores.map((done) => done.name);
      throw new CacheControlError(
        `could not clear ${directory}: ${outcome.warning}. ${
          cleared.length === 0 ? "Nothing was deleted." : `Already cleared: ${cleared.join(", ")}.`
        }`,
      );
    }
    result.stores.push({ name, ...counts });
    // The commit released the lock. Whatever is left was not created by a completed Scope write.
    for (const entry of await readdir(directory)) {
      const path = join(CACHE_DIR, name, entry);
      if (entry === LOCK_FILE) result.left.push({ path, reason: "lock held by a running Scope" });
      else if (entry.startsWith(BREAK_CLAIM_PREFIX)) {
        result.left.push({ path, reason: "lock-break claim of a running Scope (removed by its next commit)" });
      } else result.left.push({ path, reason: "not created by Scope" });
    }
    if (result.left.every((item) => !item.path.startsWith(join(CACHE_DIR, name) + "/"))) {
      await rmdir(directory).catch((error: unknown) => {
        // A run started in the meantime may have put the lock back; that is fine.
        if (codeOf(error) !== "ENOTEMPTY" && codeOf(error) !== "ENOENT") throw error;
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// rebuild

export interface RebuildResult {
  filesAnalyzed: number;
  chunks: number;
  elapsedMs: number;
  /** Scan and cache warnings, without the `scope: warning:` prefix. */
  warnings: string[];
  committed: boolean;
}

/**
 * Reanalyzes every file and rewrites the analysis cache, ignoring any cached analysis or stat record. On a current
 * cache it touches only analysis data (shards and the `files` document) and other documents stay. A stale cache
 * (another root or other version keys) is reset entirely by the commit, as by any run: its other documents were
 * recorded under that root or those versions, and keeping them under the new meta would pass them off as current.
 * Needs no task and never contacts Jev.
 */
export async function rebuildCache(
  repo: string,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    /** Test seams, as for `loadChunks`. */
    now?: () => number;
    racyMarginMs?: number;
  } = {},
): Promise<RebuildResult> {
  if ((options.env ?? process.env).SCOPE_CACHE === "off") {
    throw new UsageError("the cache is off (SCOPE_CACHE=off); scope cache rebuild has nothing to rebuild.");
  }
  const started = Date.now();
  const loaded = await loadChunks(repo, {
    signal: options.signal,
    cache: { rebuild: true, now: options.now, racyMarginMs: options.racyMarginMs },
  });
  if (options.signal?.aborted) throw new CancelledError();
  return {
    filesAnalyzed: loaded.analysis?.analyzed ?? 0,
    chunks: loaded.chunks.length,
    elapsedMs: Date.now() - started,
    warnings: loaded.warnings,
    committed: loaded.cacheCommitted === true,
  };
}
