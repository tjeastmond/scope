import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** Result of looking for the per-user integrity key: the key, or why the cache must stay off. */
export type IntegrityKey = { key: Buffer } | { warning: string };

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * Where the key lives: `$XDG_STATE_HOME/scope/cache-key` when that is an absolute path, else
 * `$HOME/.local/state/scope/cache-key`. Relative values are ignored. Undefined when neither is usable.
 */
export function integrityKeyPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : env.HOME && isAbsolute(env.HOME)
        ? join(env.HOME, ".local", "state")
        : undefined;
  return base === undefined ? undefined : join(base, "scope", "cache-key");
}

const oneLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

const memo = new Map<string, Promise<IntegrityKey>>();

async function readKey(path: string): Promise<IntegrityKey> {
  const reject = (reason: string): IntegrityKey => ({ warning: `cache disabled: integrity key ${path} ${reason}` });
  const info = await lstat(path);
  if (!info.isFile()) return reject("is not a regular file (symlinks are not followed)");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return reject("is not owned by you");
  if ((info.mode & 0o077) !== 0) return reject("is readable by others (expected mode 0600)");
  const text = (await readFile(path, "utf8")).trim();
  if (!HEX_KEY.test(text)) return reject("is not 64 hexadecimal characters");
  return { key: Buffer.from(text, "hex") };
}

/**
 * Publishes a new key atomically: it is written and flushed under a temporary name, then hard-linked into place, which
 * fails with EEXIST if another run won the race. A concurrent first run therefore never reads an empty or partial key.
 */
async function createKey(path: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function load(path: string): Promise<IntegrityKey> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await createKey(path);
    return await readKey(path);
  } catch (error) {
    return { warning: `cache disabled: integrity key ${path} unusable: ${oneLine(error)}` };
  }
}

/**
 * Loads the per-user key that authenticates cache entries, creating it on first use. A bad key file (symlink, wrong
 * owner or mode, malformed) disables the cache with a warning and is never overwritten or deleted. The key is never
 * included in a warning. Memoized per process and path.
 */
export function loadIntegrityKey(env: NodeJS.ProcessEnv = process.env): Promise<IntegrityKey> {
  const path = integrityKeyPath(env);
  if (path === undefined) {
    return Promise.resolve({
      warning: "cache disabled: no integrity key location (set XDG_STATE_HOME or HOME to an absolute path)",
    });
  }
  let result = memo.get(path);
  if (!result) {
    result = load(path);
    memo.set(path, result);
  }
  return result;
}

/**
 * Reads the per-user key without ever creating it, its directory or anything else. Undefined when no key exists yet
 * (or no location is usable); a bad key file is a warning, as for {@link loadIntegrityKey}. Not memoized.
 */
export async function readExistingIntegrityKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrityKey | undefined> {
  const path = integrityKeyPath(env);
  if (path === undefined) return undefined;
  try {
    return await readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { warning: `cache disabled: integrity key ${path} unusable: ${oneLine(error)}` };
  }
}

/** JSON with object keys sorted recursively and `undefined` members omitted, so field order never matters. */
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * HMAC-SHA256 (hex) of the version keys, the entry key and the entry without its `mac` field. The version keys are
 * signed because `meta.json` is not: an entry signed under older analyzer or redaction code must not verify under the
 * current keys, even if someone rewrites `meta.json` to them.
 */
export function entryMac(key: Buffer, versionKeys: object, entryKey: string, entry: object): string {
  const rest: Record<string, unknown> = { ...entry };
  delete rest.mac;
  return createHmac("sha256", key)
    .update(canonical([versionKeys, entryKey, rest]))
    .digest("hex");
}

/** What a stat record asserts about one file. All of it is signed. */
export interface StatFields {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  /** Analysis key of the bytes last read at the path. */
  key: string;
  /** Content-only SHA-256 of those bytes, for rename detection. */
  hash: string;
  /** Clock time (ms) when the file was last statted before being read; the racy-file guard compares against it. */
  recordedAt: number;
}

/**
 * HMAC-SHA256 (hex) of the version keys, the `"files"` domain tag, the path and the stat fields. The array has a
 * different shape from the one `entryMac` signs (ten members against three, a string where that one has an object
 * second), so a stat MAC can never verify as an entry MAC or the reverse.
 */
export function statMac(key: Buffer, versionKeys: object, path: string, fields: StatFields): string {
  const { size, mtimeMs, ctimeMs, ino, key: entryKey, hash, recordedAt } = fields;
  return createHmac("sha256", key)
    .update(canonical([versionKeys, "files", path, size, mtimeMs, ctimeMs, ino, entryKey, hash, recordedAt]))
    .digest("hex");
}

/**
 * HMAC-SHA256 (hex) of a domain tag and a record (a run-history record). The tag makes the array a different shape
 * from the ones `entryMac` and `statMac` sign, so a history MAC can never verify as either of them or the reverse.
 */
export function recordMac(key: Buffer, domain: string, record: object): string {
  return createHmac("sha256", key)
    .update(canonical([domain, record]))
    .digest("hex");
}

/** Constant-time comparison of two hex MACs; false when the lengths differ. */
export function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
