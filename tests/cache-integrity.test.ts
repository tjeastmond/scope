import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { entryMac, integrityKeyPath, loadIntegrityKey } from "../src/cache/integrity.ts";
import { loadChunks } from "../src/scope.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-integrity-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

// Each test uses its own state directory, so the per-process memo never crosses tests.
const freshState = async () => {
  const dir = await mkdtemp(join(tmp, "state-"));
  return { dir, env: { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv, keyPath: join(dir, "scope", "cache-key") };
};

describe("key creation", () => {
  test("creates a 64-hex key with mode 0600 in a 0700 directory, and reloads the same key", async () => {
    const { env, keyPath } = await freshState();
    const first = await loadIntegrityKey(env);
    expect("key" in first).toBe(true);
    if (!("key" in first)) return;
    expect(first.key.length).toBe(32);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(keyPath, ".."))).mode & 0o777).toBe(0o700);
    expect(await readFile(keyPath, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    const second = await loadIntegrityKey(env);
    expect("key" in second && second.key.equals(first.key)).toBe(true);
  });

  test("a key file written earlier is read, not replaced (a new process sees the same key)", async () => {
    const { env, keyPath } = await freshState();
    await mkdir(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    const hex = "0123456789abcdef".repeat(4);
    await writeFile(keyPath, `${hex}\n`, { mode: 0o600 });
    const loaded = await loadIntegrityKey(env);
    expect("key" in loaded && loaded.key.toString("hex") === hex).toBe(true);
  });
});

describe("key location", () => {
  test("uses an absolute XDG_STATE_HOME", () => {
    expect(integrityKeyPath({ XDG_STATE_HOME: "/x/state", HOME: "/h" })).toBe("/x/state/scope/cache-key");
  });

  test("ignores a relative XDG_STATE_HOME and falls back to HOME", () => {
    expect(integrityKeyPath({ XDG_STATE_HOME: "relative/state", HOME: "/h" })).toBe("/h/.local/state/scope/cache-key");
  });

  test("has no location without a usable XDG_STATE_HOME or HOME, and the cache is disabled with a warning", async () => {
    expect(integrityKeyPath({ XDG_STATE_HOME: "rel", HOME: "rel" })).toBeUndefined();
    const loaded = await loadIntegrityKey({});
    expect("warning" in loaded && loaded.warning.startsWith("cache disabled:")).toBe(true);
  });

  test("a relative XDG_STATE_HOME creates nothing relative to the working directory", async () => {
    const home = await mkdtemp(join(tmp, "home-"));
    const loaded = await loadIntegrityKey({ XDG_STATE_HOME: "rel-xdg-state", HOME: home });
    expect("key" in loaded).toBe(true);
    expect((await stat(join(home, ".local/state/scope/cache-key"))).isFile()).toBe(true);
    await expect(stat("rel-xdg-state")).rejects.toThrow();
  });
});

describe("rejected key files", () => {
  const HEX = "0123456789abcdef".repeat(4);

  const expectRejected = async (prepare: (keyPath: string, dir: string) => Promise<void>, reason: RegExp) => {
    const { dir, env, keyPath } = await freshState();
    await mkdir(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    await prepare(keyPath, dir);
    const before = await readdir(join(keyPath, ".."));
    const loaded = await loadIntegrityKey(env);
    expect("warning" in loaded).toBe(true);
    if (!("warning" in loaded)) return;
    expect(loaded.warning).toMatch(/^cache disabled:/);
    expect(loaded.warning).toContain(keyPath);
    expect(loaded.warning).toMatch(reason);
    expect(loaded.warning).not.toContain(HEX);
    expect(await readdir(join(keyPath, ".."))).toEqual(before);
    return keyPath;
  };

  test("a symlink is rejected and left alone", async () => {
    let target = "";
    const keyPath = await expectRejected(async (keyPath, dir) => {
      target = join(dir, "real-key");
      await writeFile(target, `${HEX}\n`, { mode: 0o600 });
      await symlink(target, keyPath);
    }, /regular file/);
    expect((await readFile(target, "utf8")).trim()).toBe(HEX);
    expect(keyPath).toBeDefined();
  });

  test("a group- or world-readable file is rejected, unchanged, and never echoed", async () => {
    for (const mode of [0o640, 0o604, 0o644]) {
      const keyPath = await expectRejected(async (keyPath) => {
        await writeFile(keyPath, `${HEX}\n`);
        await chmod(keyPath, mode);
      }, /readable by others/);
      expect((await readFile(keyPath!, "utf8")).trim()).toBe(HEX);
      expect((await stat(keyPath!)).mode & 0o777).toBe(mode);
    }
  });

  test("a malformed file is rejected and unchanged", async () => {
    for (const content of ["not a key\n", `${HEX.slice(1)}\n`, `${HEX.toUpperCase()}\n`, ""]) {
      const keyPath = await expectRejected(async (keyPath) => {
        await writeFile(keyPath, content, { mode: 0o600 });
      }, /64 hexadecimal/);
      expect(await readFile(keyPath!, "utf8")).toBe(content);
    }
  });
});

describe("entryMac", () => {
  const key = Buffer.alloc(32, 7);
  const entry = { path: "a.ts", chunks: [{ id: "c", name: "f", startLine: 1 }], warnings: ["w"], textOnly: false };

  test("is independent of field order and of undefined members, and ignores an existing mac", () => {
    const reordered = {
      textOnly: false,
      warnings: ["w"],
      chunks: [{ startLine: 1, name: "f", id: "c", x: undefined }],
      path: "a.ts",
    };
    const base = entryMac(key, "k".repeat(64), entry);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(entryMac(key, "k".repeat(64), reordered)).toBe(base);
    expect(entryMac(key, "k".repeat(64), { ...entry, mac: "anything" })).toBe(base);
  });

  test("changes when any field, the entry key or the key changes", () => {
    const base = entryMac(key, "k".repeat(64), entry);
    const variants = [
      { ...entry, path: "b.ts" },
      { ...entry, warnings: [] },
      { ...entry, textOnly: true },
      { ...entry, chunks: [] },
      { ...entry, chunks: [{ id: "c", name: "g", startLine: 1 }] },
    ];
    for (const variant of variants) expect(entryMac(key, "k".repeat(64), variant)).not.toBe(base);
    expect(entryMac(key, "j".repeat(64), entry)).not.toBe(base);
    expect(entryMac(Buffer.alloc(32, 8), "k".repeat(64), entry)).not.toBe(base);
  });
});

describe("end to end", () => {
  test("an unusable key disables the cache with a warning, writes no shards and still gives correct output", async () => {
    const repo = join(tmp, "repo");
    await cp(join(import.meta.dir, "../fixtures/webhook-service"), repo, { recursive: true });
    const { env, keyPath } = await freshState();
    await mkdir(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(keyPath, "garbage\n", { mode: 0o600 });
    const plain = await loadChunks(repo);
    const run = await loadChunks(repo, { cache: { integrityEnv: env } });
    expect(run.warnings.some((warning) => warning.startsWith("cache disabled:"))).toBe(true);
    expect(run.chunks).toEqual(plain.chunks);
    await expect(stat(join(repo, ".scope"))).rejects.toThrow();
  });
});
