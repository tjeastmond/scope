import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** A lock older than this is stale and may be broken. A commit takes milliseconds. */
export const LOCK_STALE_MS = 30_000;
/** How long a commit waits for the lock before giving up and skipping the write. */
export const LOCK_WAIT_MS = 2_000;
/** A stray `.tmp` file older than this is left over from an interrupted write and is removed by the next commit. */
export const TMP_MAX_AGE_MS = 60_000;

const LOCK_POLL_MS = 25;
const LOCK_FILE = "lock";
const BREAK_GUARD_FILE = "lock.break";
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_WARNING_LENGTH = 200;

/** One kind of stored document: `<name>.json` holding `{ "schemaVersion": n, ...payload }`. */
export interface DocumentType<T> {
  /** File name without extension, e.g. `files` for `files.json`. Lowercase letters, digits and `-`, starting with a letter. */
  name: string;
  /** The version written. */
  schemaVersion: number;
  /** Shape check of the payload, which is everything except `schemaVersion`. */
  validate(payload: unknown): payload is T;
  /** Converts an older payload to the current shape. Returning `undefined` discards it. Without it, older documents are discarded. */
  migrate?(fromVersion: number, payload: unknown): T | undefined;
}

export interface ReadOutcome<T> {
  /** `undefined` when the document is missing or unusable; the caller rebuilds from source. */
  value: T | undefined;
  /** Set only when a document existed but could not be used. One line. */
  warning?: string;
}

/** Staged changes inside a commit. Nothing is written until the update function returns. */
export interface Transaction {
  /** Reads fresh from disk inside the lock; a missing or unusable document is `undefined`. */
  read<T>(type: DocumentType<T>): Promise<T | undefined>;
  /** Stages a document; written atomically after the update function returns. The payload must be a plain object. */
  write<T>(type: DocumentType<T>, value: T): void;
  /** Stages a deletion. */
  remove(type: DocumentType<unknown>): void;
}

export type CommitOutcome = { committed: true } | { committed: false; warning: string };

export interface DocumentStoreOptions {
  /** Age after which a lock is stale. Defaults to {@link LOCK_STALE_MS}; tests shorten it. */
  lockStaleMs?: number;
  /** Default wait for the lock. Defaults to {@link LOCK_WAIT_MS}. */
  lockWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const randomHex = () => randomBytes(8).toString("hex");
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const oneLine = (text: string) => text.replace(/\s+/g, " ").slice(0, MAX_WARNING_LENGTH);

const REASONS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
  ENOTDIR: "a parent of the path is not a directory",
  EISDIR: "the path is a directory",
  EDQUOT: "quota exceeded",
};
const reason = (error: unknown) => oneLine(REASONS[codeOf(error) ?? ""] ?? (error as Error)?.message ?? String(error));

function assertName(type: { name: string }): void {
  if (!NAME_PATTERN.test(type.name)) throw new Error(`invalid document name: ${type.name}`);
}

/** Result of reading one file: a usable value, nothing, or nothing with the reason. */
type Parsed<T> = { value: T } | { value?: undefined; problem?: string };

/**
 * Parses and checks a document. Content problems never throw; they come back as a short `problem`.
 * A missing file has no problem (nothing was lost).
 */
async function parseDocument<T>(path: string, type: DocumentType<T>): Promise<Parsed<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return codeOf(error) === "ENOENT" ? {} : { problem: `unreadable (${reason(error)})` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problem: "not valid JSON (truncated or corrupt)" };
  }
  if (!isPlainObject(doc)) return { problem: "not a JSON object" };
  const { schemaVersion, ...payload } = doc;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { problem: "missing or invalid schemaVersion" };
  }
  if (schemaVersion > type.schemaVersion) return { problem: `schemaVersion ${schemaVersion} is newer than supported` };
  if (schemaVersion < type.schemaVersion) {
    let migrated: T | undefined;
    try {
      migrated = type.migrate?.(schemaVersion, payload);
    } catch {
      migrated = undefined;
    }
    if (migrated === undefined) return { problem: `schemaVersion ${schemaVersion} is outdated` };
    // A migration is code too: its result must pass the same shape check as a current document.
    if (!type.validate(migrated)) return { problem: `schemaVersion ${schemaVersion} could not be migrated` };
    return { value: migrated };
  }
  if (!type.validate(payload)) return { problem: "unexpected shape" };
  return { value: payload };
}

/** Writes `text` to `path` atomically: temporary file in the same directory, flushed, then renamed over the target. */
async function writeAtomic(directory: string, name: string, text: string): Promise<void> {
  const temp = join(directory, `.${name}.${randomHex()}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(directory, `${name}.json`));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * A directory of versioned JSON documents. Reads take no lock and see the old or the new document, never a partial
 * one. Writes go through {@link DocumentStore.commit}: one short critical section under a lock file. Any problem with
 * the store's content or the file system degrades to "not cached" and never fails the caller's run.
 */
export class DocumentStore {
  readonly directory: string;
  readonly #staleMs: number;
  readonly #waitMs: number;

  /** `directory` is absolute and is created on the first commit. Choosing it is the caller's concern. */
  constructor(directory: string, options: DocumentStoreOptions = {}) {
    this.directory = directory;
    this.#staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
    this.#waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  }

  /** Missing document: `{ value: undefined }` with no warning. Unusable document: no value and a one-line warning. */
  async read<T>(type: DocumentType<T>): Promise<ReadOutcome<T>> {
    assertName(type);
    const parsed = await parseDocument(join(this.directory, `${type.name}.json`), type);
    if ("problem" in parsed && parsed.problem) {
      return { value: undefined, warning: oneLine(`${type.name}.json: ${parsed.problem}; rebuilding`) };
    }
    return { value: parsed.value };
  }

  /**
   * Runs `update` under the store lock and writes what it staged, each document atomically. If `update` throws,
   * nothing is written and the error propagates. Lock contention and file system errors do not throw: the outcome
   * says the run was not cached.
   */
  async commit(
    update: (tx: Transaction) => Promise<void> | void,
    options: { lockWaitMs?: number } = {},
  ): Promise<CommitOutcome> {
    const staged = new Map<string, { type: DocumentType<unknown>; text: string | undefined }>();
    const tx: Transaction = {
      read: async (type) => {
        assertName(type);
        return (await parseDocument(join(this.directory, `${type.name}.json`), type)).value;
      },
      write: (type, value) => {
        assertName(type);
        if (!isPlainObject(value)) throw new TypeError(`${type.name}: payload must be a plain object`);
        if ("schemaVersion" in value) throw new TypeError(`${type.name}: payload must not contain schemaVersion`);
        staged.set(type.name, {
          type: type as DocumentType<unknown>,
          text: JSON.stringify({ schemaVersion: type.schemaVersion, ...value }),
        });
      },
      remove: (type) => {
        assertName(type);
        staged.set(type.name, { type, text: undefined });
      },
    };

    let token: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true });
      token = await this.#acquire(options.lockWaitMs ?? this.#waitMs);
      if (token === undefined) return { committed: false, warning: "cache busy; this run was not cached" };
    } catch (error) {
      return { committed: false, warning: `cache not written: ${reason(error)}` };
    }
    try {
      await this.#sweepTemps().catch(() => undefined);
      // An error from `update` (including a bad staged write) propagates, whatever its type; nothing is written.
      await update(tx);
      // Defense in depth: never write unless the lock file still holds our token.
      if ((await this.#readLockToken(join(this.directory, LOCK_FILE))) !== token) {
        return { committed: false, warning: "cache lock lost; this run was not cached" };
      }
      try {
        for (const [name, { text }] of staged) {
          if (text === undefined) await rm(join(this.directory, `${name}.json`), { force: true });
          else await writeAtomic(this.directory, name, text);
        }
      } catch (error) {
        return { committed: false, warning: `cache not written: ${reason(error)}` };
      }
      return { committed: true };
    } finally {
      await this.#release(token);
    }
  }

  /** Creates the lock file exclusively. Returns our token, or `undefined` if the lock stayed held for `waitMs`. */
  async #acquire(waitMs: number): Promise<string | undefined> {
    const lockPath = join(this.directory, LOCK_FILE);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const token = randomHex();
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ token, createdAt: Date.now() }), "utf8");
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      if (Date.now() >= deadline) return undefined;
      if (await this.#breakIfStale(lockPath)) continue;
      await sleep(LOCK_POLL_MS);
    }
  }

  /**
   * Removes a stale lock. Breaking is serialized by a guard file (`lock.break`, exclusive create): only its holder may
   * break, and it re-reads the lock under the guard and proceeds only if that is still the same stale lock. A fresh
   * lock taken in between is therefore never moved. Returns `true` to retry the exclusive create right away.
   */
  async #breakIfStale(lockPath: string): Promise<boolean> {
    const seen = await this.#inspectLock(lockPath);
    if (seen === undefined) return true; // vanished: retry right away
    if (seen.age <= this.#staleMs) return false;
    const guardPath = join(this.directory, BREAK_GUARD_FILE);
    try {
      await (await open(guardPath, "wx")).close();
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      const guard = await this.#inspectLock(guardPath);
      if (guard === undefined) return true;
      if (guard.age <= this.#staleMs) return false; // another breaker is at work: keep waiting
      await rm(guardPath, { force: true }); // its holder crashed
      return true;
    }
    try {
      const current = await this.#inspectLock(lockPath);
      if (current === undefined) return true;
      const same =
        seen.token !== undefined
          ? current.token === seen.token
          : current.ino === seen.ino && current.mtimeMs === seen.mtimeMs;
      if (current.age <= this.#staleMs || !same) return false; // replaced by a live lock in the meantime
      const moved = join(this.directory, `.${LOCK_FILE}.${randomHex()}.tmp`);
      try {
        await rename(lockPath, moved);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
        return true;
      }
      await rm(moved, { force: true }).catch(() => undefined);
      return true;
    } finally {
      await rm(guardPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Age of a lock in ms (the older of its own modification time and the `createdAt` it records), its token and file
   * identity. `undefined` if missing. Uses lstat, so a symlink is judged by itself; other lstat errors propagate.
   * Reading the content is best effort.
   */
  async #inspectLock(
    path: string,
  ): Promise<{ age: number; token: string | undefined; ino: number; mtimeMs: number } | undefined> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
    let created = info.mtimeMs;
    let token: string | undefined;
    try {
      const doc: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isPlainObject(doc)) {
        if (typeof doc.createdAt === "number" && Number.isFinite(doc.createdAt)) created = doc.createdAt;
        if (typeof doc.token === "string") token = doc.token;
      }
    } catch {
      // Empty while its owner is still writing it, or unreadable: the modification time decides.
    }
    return { age: Date.now() - Math.min(info.mtimeMs, created), token, ino: info.ino, mtimeMs: info.mtimeMs };
  }

  /** The token recorded in the lock file, or `undefined` if it is missing or unreadable. */
  async #readLockToken(path: string): Promise<string | undefined> {
    try {
      const doc: unknown = JSON.parse(await readFile(path, "utf8"));
      return isPlainObject(doc) && typeof doc.token === "string" ? doc.token : undefined;
    } catch {
      return undefined;
    }
  }

  /** Removes the lock only if it still holds our token; a lock another run took over is left alone. */
  async #release(token: string): Promise<void> {
    const lockPath = join(this.directory, LOCK_FILE);
    try {
      const doc: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (isPlainObject(doc) && doc.token === token) await rm(lockPath, { force: true });
    } catch {
      // Already gone or unreadable: nothing of ours to release.
    }
  }

  /** Removes `.tmp` files left by interrupted writes once they are old enough not to belong to a live one. */
  async #sweepTemps(): Promise<void> {
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".tmp")) continue;
      const path = join(this.directory, entry);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile() && Date.now() - info.mtimeMs > TMP_MAX_AGE_MS) await rm(path, { force: true });
    }
  }
}
