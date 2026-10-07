import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR, commitRepositoryCache, openRepositoryCache } from "../src/cache/location.ts";
import type { DocumentType } from "../src/cache/store.ts";
import { STORE_MAJOR, currentVersionKeys, type VersionKeys } from "../src/cache/versions.ts";
import { scanRepository } from "../src/repository/files.ts";

interface Seed {
  value: string;
}
const seed: DocumentType<Seed> = {
  name: "seed",
  schemaVersion: 1,
  validate: (payload): payload is Seed => typeof (payload as Seed)?.value === "string",
};

const keys: VersionKeys = {
  store: 1,
  scope: "1.0.0",
  analyzer: "a".repeat(64),
  treeSitter: "0.25.0",
  grammars: { one: "1.0.0", two: "2.0.0" },
};

let base: string;
let repo: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "scope-location-test-")));
  repo = join(base, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
});
afterEach(async () => {
  await chmod(repo, 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

async function commitSeed(root: string, k = keys, value = "x") {
  const { cache } = await openRepositoryCache(root, { keys: k });
  const outcome = await commitRepositoryCache(cache!, (tx) => tx.write(seed, { value }));
  expect(outcome).toEqual({ committed: true });
  return cache!;
}

describe("openRepositoryCache and commitRepositoryCache", () => {
  test("first open is fresh; after a commit a reopen is not", async () => {
    const first = await openRepositoryCache(repo, { keys });
    expect(first.warnings).toEqual([]);
    expect(first.cache?.fresh).toBe(true);
    expect(first.cache?.directory).toBe(join(repo, CACHE_DIR, `store-v${STORE_MAJOR}`));
    expect(first.cache?.root).toBe(repo);
    await commitSeed(repo);
    const again = await openRepositoryCache(repo, { keys });
    expect(again.cache?.fresh).toBe(false);
    expect((await again.cache!.store.read(seed)).value).toEqual({ value: "x" });
  });

  test("opening writes nothing", async () => {
    await openRepositoryCache(repo, { keys });
    expect(await readdir(repo)).not.toContain(CACHE_DIR);
  });

  test("two repositories have isolated stores", async () => {
    const other = join(base, "other");
    await mkdir(other);
    await commitSeed(repo);
    const { cache } = await openRepositoryCache(other, { keys });
    expect((await cache!.store.read(seed)).value).toBeUndefined();
    expect(cache!.fresh).toBe(true);
  });

  test("a symlinked path to the same repository is not fresh", async () => {
    await commitSeed(repo);
    const link = join(base, "link");
    await symlink(repo, link);
    const { cache } = await openRepositoryCache(link, { keys });
    expect(cache!.fresh).toBe(false);
    expect(cache!.root).toBe(repo);
  });

  test("a copied repository is fresh and its next commit removes the old documents", async () => {
    await commitSeed(repo);
    const copy = join(base, "copy");
    await cp(repo, copy, { recursive: true });
    const { cache } = await openRepositoryCache(copy, { keys });
    expect(cache!.fresh).toBe(true);
    expect((await cache!.store.read(seed)).value).toEqual({ value: "x" });
    expect(await commitRepositoryCache(cache!)).toEqual({ committed: true });
    expect((await cache!.store.read(seed)).value).toBeUndefined();
    expect((await openRepositoryCache(copy, { keys })).cache!.fresh).toBe(false);
  });

  test("invalidation is decided under the lock: other keys committed after open are dropped", async () => {
    await commitSeed(repo);
    const { cache: stale } = await openRepositoryCache(repo, { keys });
    expect(stale!.fresh).toBe(false);
    await commitSeed(repo, { ...keys, scope: "2.0.0" }, "other");
    expect(await commitRepositoryCache(stale!)).toEqual({ committed: true });
    expect((await stale!.store.read(seed)).value).toBeUndefined();
  });

  test("reusing a handle opened fresh keeps what it committed", async () => {
    const { cache } = await openRepositoryCache(repo, { keys });
    expect(cache!.fresh).toBe(true);
    expect(await commitRepositoryCache(cache!, (tx) => tx.write(seed, { value: "x" }))).toEqual({ committed: true });
    expect(await commitRepositoryCache(cache!)).toEqual({ committed: true });
    expect((await cache!.store.read(seed)).value).toEqual({ value: "x" });
  });

  test("an update reading after invalidation does not see the dropped documents", async () => {
    await commitSeed(repo);
    const { cache } = await openRepositoryCache(repo, { keys: { ...keys, scope: "2.0.0" } });
    let seen: Seed | undefined = { value: "unset" };
    await commitRepositoryCache(cache!, async (tx) => {
      seen = await tx.read(seed);
    });
    expect(seen).toBeUndefined();
  });

  const changes: [string, (k: VersionKeys) => VersionKeys][] = [
    ["store", (k) => ({ ...k, store: k.store + 1 })],
    ["scope", (k) => ({ ...k, scope: "1.0.1" })],
    ["analyzer", (k) => ({ ...k, analyzer: "b".repeat(64) })],
    ["treeSitter", (k) => ({ ...k, treeSitter: "0.26.0" })],
    ["a grammar", (k) => ({ ...k, grammars: { ...k.grammars, two: "2.0.1" } })],
  ];
  for (const [label, change] of changes) {
    test(`a changed ${label} key makes the cache fresh and the next commit drops old documents`, async () => {
      await commitSeed(repo);
      const changed = change(keys);
      const { cache } = await openRepositoryCache(repo, { keys: changed });
      expect(cache!.fresh).toBe(true);
      expect(await commitRepositoryCache(cache!)).toEqual({ committed: true });
      expect((await cache!.store.read(seed)).value).toBeUndefined();
      expect((await openRepositoryCache(repo, { keys: changed })).cache!.fresh).toBe(false);
      await commitSeed(repo, changed, "y");
      const reopened = await openRepositoryCache(repo, { keys: changed });
      expect((await reopened.cache!.store.read(seed)).value).toEqual({ value: "y" });
    });
  }

  test("creates .scope/.gitignore with *, and leaves an existing one alone", async () => {
    await commitSeed(repo);
    expect(await readFile(join(repo, CACHE_DIR, ".gitignore"), "utf8")).toBe("*\n");
    await writeFile(join(repo, CACHE_DIR, ".gitignore"), "custom\n");
    await commitSeed(repo);
    expect(await readFile(join(repo, CACHE_DIR, ".gitignore"), "utf8")).toBe("custom\n");
  });

  test("never writes a .gitignore at the repository root", async () => {
    await commitSeed(repo);
    expect(await readdir(repo)).not.toContain(".gitignore");
  });

  test("a symlinked store directory is refused on open and on commit, and its target is untouched", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "settings.json"), "{}");
    const { cache } = await openRepositoryCache(repo, { keys });
    await mkdir(join(repo, CACHE_DIR));
    await symlink(outside, cache!.directory);
    const reopened = await openRepositoryCache(repo, { keys });
    expect(reopened.cache).toBeUndefined();
    expect(reopened.warnings[0]).toContain("symlinks are not followed");
    const outcome = await commitRepositoryCache(cache!);
    expect(outcome.committed).toBe(false);
    expect((await readdir(outside)).sort()).toEqual(["settings.json"]);
  });

  test("a symlinked .scope directory is refused on open and on commit, and its target is untouched", async () => {
    const outside = join(base, "outside");
    await mkdir(join(outside, `store-v${STORE_MAJOR}`), { recursive: true });
    await writeFile(join(outside, `store-v${STORE_MAJOR}`, "settings.json"), "{}");
    const { cache } = await openRepositoryCache(repo, { keys });
    await symlink(outside, join(repo, CACHE_DIR));
    expect((await openRepositoryCache(repo, { keys })).cache).toBeUndefined();
    expect((await commitRepositoryCache(cache!)).committed).toBe(false);
    expect((await readdir(outside)).sort()).toEqual([`store-v${STORE_MAJOR}`]);
    expect(await readdir(join(outside, `store-v${STORE_MAJOR}`))).toEqual(["settings.json"]);
  });

  test("a store directory replaced by a symlink while the lock is awaited is refused", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "settings.json"), "{}");
    await writeFile(join(outside, "old.tmp"), "x");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(join(outside, "old.tmp"), old, old);
    const { cache } = await openRepositoryCache(repo, { keys });
    await mkdir(cache!.directory, { recursive: true });
    await writeFile(join(cache!.directory, "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const pending = commitRepositoryCache(cache!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rename(cache!.directory, `${cache!.directory}.held`);
    await symlink(outside, cache!.directory);
    const outcome = await pending;
    expect(outcome.committed).toBe(false);
    expect(outcome.committed === false && outcome.warning).toContain("symlinks are not followed");
    expect((await readdir(outside)).sort()).toEqual(["old.tmp", "settings.json"]);
  });

  test("a store directory of another major survives a commit", async () => {
    const old = join(repo, CACHE_DIR, "store-v0");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "files.json"), "{}");
    await commitSeed(repo);
    expect(await readFile(join(old, "files.json"), "utf8")).toBe("{}");
  });

  test("a corrupt meta.json is fresh with a warning", async () => {
    const cache = await commitSeed(repo);
    await writeFile(join(cache.directory, "meta.json"), "{ not json");
    const again = await openRepositoryCache(repo, { keys });
    expect(again.cache!.fresh).toBe(true);
    expect(again.warnings).toHaveLength(1);
    expect(again.warnings[0]).toContain("meta.json");
  });

  test("an unwritable repository root gives committed:false with a warning", async () => {
    if (process.getuid?.() === 0) return;
    const { cache } = await openRepositoryCache(repo, { keys });
    await chmod(repo, 0o500);
    const outcome = await commitRepositoryCache(cache!, (tx) => tx.write(seed, { value: "x" }));
    expect(outcome.committed).toBe(false);
    expect(outcome.committed === false && outcome.warning).toBeTruthy();
  });

  test("a missing repository gives a disabled cache and a warning, not a throw", async () => {
    const result = await openRepositoryCache(join(base, "nope"), { keys });
    expect(result.cache).toBeUndefined();
    expect(result.warnings[0]).toStartWith("cache disabled: ");
  });

  test("the scanner never lists .scope/ paths", async () => {
    await commitSeed(repo);
    const scan = await scanRepository(repo);
    expect(scan.files).toContain("a.ts");
    expect(scan.files.some((path) => path.startsWith(`${CACHE_DIR}/`))).toBe(false);
  });
});

describe("currentVersionKeys", () => {
  test("reports real versions and is stable", async () => {
    const current = await currentVersionKeys();
    expect(current.treeSitter).toMatch(/^\d+\.\d+\.\d+/);
    expect(current.analyzer).toMatch(/^[0-9a-f]{64}$/);
    expect(current.store).toBe(STORE_MAJOR);
    expect(current.scope).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(current.grammars).sort()).toEqual([
      "@tree-sitter-grammars/tree-sitter-yaml",
      "tree-sitter-wasms",
    ]);
    expect(await currentVersionKeys()).toEqual(current);
  });
});
