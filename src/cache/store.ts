import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** A lock older than this is stale and may be broken. A commit takes milliseconds. */
export const LOCK_STALE_MS = 30_000;
/** How long a commit waits for the lock before giving up and skipping the write. */
export const LOCK_WAIT_MS = 2_000;
/** A stray `.tmp` file older than this is left over from an interrupted write and is removed by the next commit. */
export const TMP_MAX_AGE_MS = 60_000;

const LOCK_POLL_MS = 25;
const LOCK_FILE = "lock";
const BREAK_CLAIM_PREFIX = ".lock.break.";
const MAX_BREAK_LEVEL = 8;
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
  /**
   * Reads fresh from disk inside the lock; a missing or unusable document is `undefined`. A document staged for
   * removal in this transaction reads as `undefined`; a staged write reads back as written.
   */
  read<T>(type: DocumentType<T>): Promise<T | undefined>;
  /** Stages a document; written atomically after the update function returns. The payload must be a plain object. */
  write<T>(type: DocumentType<T>, value: T): void;
  /** Stages a deletion. */
  remove(type: DocumentType<unknown>): void;
  /** Names of the documents present on disk (`*.json` files whose name is valid), without the extension. */
  list(): Promise<string[]>;
  /** Stages the deletion of a document by name, for documents whose type the caller does not know. */
  removeName(name: string): void;
}

export type CommitOutcome = { committed: true } | { committed: false; warning: string };

export interface DocumentStoreOptions {
  /** Age after which a lock is stale. Defaults to {@link LOCK_STALE_MS}; tests shorten it. */
  lockStaleMs?: number;
  /** Default wait for the lock. Defaults to {@link LOCK_WAIT_MS}. */
  lockWaitMs?: number;
  /** Test seam: runs after a breaker has re-checked a stale lock and before it moves it away. */
  beforeBreakRename?: () => Promise<void> | void;
  /**
   * Throws if the store directory is no longer the one the caller chose (for example, replaced by a symlink). A commit
   * runs it before every attempt to take the lock, before claiming and before moving a stale lock, after taking the
   * lock and before any cleanup or update, and before writing; a failure means nothing more is touched and the commit is not cached.
   */
  verifyDirectory?: () => Promise<void> | void;
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
/** Identity of a lock for break claims: its token, or failing that its inode and modification time. */
const lockIdentity = (lock: { token: string | undefined; ino: number; mtimeMs: number }): string =>
  createHash("sha256")
    .update(lock.token ?? `${lock.ino}:${lock.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
const reason = (error: unknown) => oneLine(REASONS[codeOf(error) ?? ""] ?? (error as Error)?.message ?? String(error));

function assertName(type: { name: string }): void {
  if (!NAME_PATTERN.test(type.name)) throw new Error(`invalid document name: ${type.name}`);
}

/**
 * Reads a regular file as UTF-8. Symlinks are not followed and the open never blocks, so a FIFO or device (or a link
 * to one) cannot hang the store; anything that is not a regular file throws and callers treat it as unreadable.
 */
async function readRegularFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Object.assign(new Error("not a regular file"), { code: "EINVAL" });
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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
    text = await readRegularFile(path);
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
  readonly #beforeBreakRename: (() => Promise<void> | void) | undefined;
  readonly #verifyDirectory: () => Promise<void> | void;

  /** `directory` is absolute and is created on the first commit. Choosing it is the caller's concern. */
  constructor(directory: string, options: DocumentStoreOptions = {}) {
    this.directory = directory;
    this.#staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
    this.#beforeBreakRename = options.beforeBreakRename;
    this.#verifyDirectory = options.verifyDirectory ?? (() => undefined);
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
    const staged = new Map<string, { type: DocumentType<unknown>; text: string | undefined; value?: unknown }>();
    const tx: Transaction = {
      read: async <T>(type: DocumentType<T>) => {
        assertName(type);
        const pending = staged.get(type.name);
        if (pending) return pending.value as T | undefined;
        return (await parseDocument(join(this.directory, `${type.name}.json`), type)).value;
      },
      write: (type, value) => {
        assertName(type);
        if (!isPlainObject(value)) throw new TypeError(`${type.name}: payload must be a plain object`);
        if ("schemaVersion" in value) throw new TypeError(`${type.name}: payload must not contain schemaVersion`);
        const text = JSON.stringify({ schemaVersion: type.schemaVersion, ...value });
        // Read back what will be written, not the caller's (mutable) object.
        const written = JSON.parse(text) as Record<string, unknown>;
        delete written.schemaVersion;
        staged.set(type.name, { type: type as DocumentType<unknown>, text, value: written });
      },
      remove: (type) => {
        assertName(type);
        staged.set(type.name, { type, text: undefined });
      },
      list: async () => {
        const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name.slice(0, -".json".length))
          .filter((name) => NAME_PATTERN.test(name))
          .sort();
      },
      removeName: (name) => {
        assertName({ name });
        staged.set(name, { type: { name } as DocumentType<unknown>, text: undefined });
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
      try {
        await this.#verifyDirectory();
      } catch (error) {
        return { committed: false, warning: `cache not written: ${reason(error)}` };
      }
      await this.#sweepTemps().catch(() => undefined);
      // An error from `update` (including a bad staged write) propagates, whatever its type; nothing is written.
      await update(tx);
      // Defense in depth: never write unless the lock file still holds our token.
      if ((await this.#readLockToken(join(this.directory, LOCK_FILE))) !== token) {
        return { committed: false, warning: "cache lock lost; this run was not cached" };
      }
      try {
        await this.#verifyDirectory();
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
      await this.#verifyDirectory();
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
   * Removes a stale lock. A breaker first claims the break by exclusively creating `.lock.break.<id>.<level>.tmp`, where
   * `id` identifies the stale lock it saw; only the claimant may break, and it re-inspects the lock first. Claims are
   * never deleted by breakers (the temp sweep removes them), so a late breaker with an outdated view can only claim
   * the old identity and its re-check finds a different lock. A fresh claim means another breaker is at work; a stale
   * one means its claimant crashed, so the next level is tried. Returns `true` to retry the exclusive create right away.
   */
  async #breakIfStale(lockPath: string): Promise<boolean> {
    const seen = await this.#inspectLock(lockPath);
    if (seen === undefined) return true; // vanished: retry right away
    if (seen.age <= this.#staleMs) return false;
    const id = lockIdentity(seen);
    let claimed = false;
    for (let level = 0; level <= MAX_BREAK_LEVEL && !claimed; level++) {
      const claim = join(this.directory, `${BREAK_CLAIM_PREFIX}${id}.${level}.tmp`);
      await this.#verifyDirectory();
      try {
        await (await open(claim, "wx")).close();
        claimed = true;
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
        const existing = await this.#inspectLock(claim);
        if (existing === undefined) return true; // swept in the meantime
        if (existing.age <= this.#staleMs) return false; // another breaker is at work: keep waiting
      }
    }
    if (!claimed) return false;
    const current = await this.#inspectLock(lockPath);
    if (current === undefined) return true;
    if (lockIdentity(current) !== id || current.age <= this.#staleMs) return true; // replaced by another lock
    await this.#beforeBreakRename?.();
    await this.#verifyDirectory();
    const moved = join(this.directory, `.${LOCK_FILE}.${randomHex()}.tmp`);
    try {
      await rename(lockPath, moved);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      return true;
    }
    // A breaker stalled for longer than the stale threshold between its re-check and the rename may have moved a live
    // lock that replaced the stale one. Put that lock back; if the slot was taken in the meantime, the moved lock's
    // owner finds a foreign token before writing and skips its commit ("cache lock lost").
    const movedLock = await this.#inspectLock(moved).catch(() => undefined);
    if (movedLock !== undefined && lockIdentity(movedLock) !== id) await link(moved, lockPath).catch(() => undefined);
    await rm(moved, { force: true }).catch(() => undefined);
    return true;
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
      const doc: unknown = JSON.parse(await readRegularFile(path));
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
      const doc: unknown = JSON.parse(await readRegularFile(path));
      return isPlainObject(doc) && typeof doc.token === "string" ? doc.token : undefined;
    } catch {
      return undefined;
    }
  }

  /** Removes the lock only if it still holds our token; a lock another run took over is left alone. */
  async #release(token: string): Promise<void> {
    const lockPath = join(this.directory, LOCK_FILE);
    try {
      // A replaced directory is left alone; our lock in the original goes stale and is broken by a later run.
      await this.#verifyDirectory();
      const doc: unknown = JSON.parse(await readRegularFile(lockPath));
      if (isPlainObject(doc) && doc.token === token) await rm(lockPath, { force: true });
    } catch {
      // Already gone, unreadable or the directory was replaced: nothing of ours to release.
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
