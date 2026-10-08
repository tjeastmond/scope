import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
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

async function load(path: string): Promise<IntegrityKey> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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

/** JSON with object keys sorted recursively and `undefined` members omitted, so field order never matters. */
function canonical(value: unknown): string {
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

/** HMAC-SHA256 (hex) of the entry key and the entry without its `mac` field. */
export function entryMac(key: Buffer, entryKey: string, entry: object): string {
  const rest: Record<string, unknown> = { ...entry };
  delete rest.mac;
  return createHmac("sha256", key)
    .update(canonical([entryKey, rest]))
    .digest("hex");
}

/** Constant-time comparison of two hex MACs; false when the lengths differ. */
export function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
