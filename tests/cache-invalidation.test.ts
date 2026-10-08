import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parser } from "web-tree-sitter";
import { isFilesDocument, isShard } from "../src/cache/analysis.ts";
import { entryMac, loadIntegrityKey, statMac, type StatFields } from "../src/cache/integrity.ts";
import { TMP_MAX_AGE_MS } from "../src/cache/store.ts";
import { currentVersionKeys, type VersionKeys } from "../src/cache/versions.ts";
import { loadChunks } from "../src/scope.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-invalidation-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function copyFixture(name: string, as = name): Promise<string> {
  const repo = join(tmp, as);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

/** Records are taken an hour "later" than the files were written, so none is racy unless a test says so. */
const later = () => Date.now() + HOUR;
const warm = (repo: string, keys?: VersionKeys) => loadChunks(repo, { cache: { now: later, keys } });

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const storeNames = async (repo: string) => (await readdir(storeDir(repo))).sort();
const shardNames = async (repo: string) => (await storeNames(repo)).filter((name) => name.startsWith("analysis-"));
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
type StoredRecord = StatFields & { mac: string };
const readRecords = async (repo: string) =>
  (await readJson<{ files: Record<string, StoredRecord> }>(join(storeDir(repo), "files.json"))).files;
const storedPaths = async (repo: string) => {
  const paths: string[] = [];
  for (const name of await shardNames(repo)) {
    const shard = await readJson<{ entries: Record<string, { path: string }> }>(join(storeDir(repo), name));
    paths.push(...Object.values(shard.entries).map((entry) => entry.path));
  }
  return paths;
};

const entryKeys = async (repo: string) => {
  const keys: string[] = [];
  for (const name of await shardNames(repo)) {
    keys.push(...Object.keys((await readJson<{ entries: object }>(join(storeDir(repo), name))).entries));
  }
  return keys.sort();
};

/** Counts real Tree-sitter parses made while `run` executes. */
async function countParses<T>(run: () => Promise<T>): Promise<{ result: T; parses: number }> {
  const spy = spyOn(Parser.prototype, "parse");
  try {
    const result = await run();
    return { result, parses: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

/** A warm run must equal an uncached run on the same tree, chunks and warnings alike. */
async function expectConverged(repo: string, run: Awaited<ReturnType<typeof warm>>) {
  const plain = await loadChunks(repo);
  expect(run.chunks).toEqual(plain.chunks);
  expect(run.warnings).toEqual(plain.warnings);
}

async function setup(name = "webhook-service") {
  const repo = await copyFixture(name);
  const { result: cold, parses } = await countParses(() => warm(repo));
  const total = cold.analysis!.analyzed;
  expect(total).toBeGreaterThan(5);
  expect(cold.analysis).toMatchObject({ reused: 0, statHits: 0, renamed: 0 });
  return { repo, total, cold, parses };
}

describe("reuse is proven by counting real parses", () => {
  for (const fixture of ["webhook-service", "mixed-app"]) {
    test(`${fixture}: a cold run parses, a no-change warm run parses nothing`, async () => {
      const { repo, parses, total } = await setup(fixture);
      // The spy must actually observe parses, or every "0" below would prove nothing.
      expect(parses).toBeGreaterThan(0);
      const { result, parses: warmParses } = await countParses(() => warm(repo));
      expect(warmParses).toBe(0);
      expect(result.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
      await expectConverged(repo, result);
    });
  }

  test("an edited TypeScript file costs exactly the parses of analyzing that file alone", async () => {
    const { repo, total } = await setup();
    const target = "src/util/retry.ts";
    const edited = `${await readFile(join(repo, target), "utf8")}\nexport const added = 1;\n`;
    await writeFile(join(repo, target), edited);

    // The same file in a repository of its own, with the cache off: what one cold analysis of it costs.
    const alone = join(tmp, "alone");
    await mkdir(join(alone, "src/util"), { recursive: true });
    await writeFile(join(alone, target), edited);
    const expected = (await countParses(() => loadChunks(alone))).parses;
    expect(expected).toBeGreaterThan(0);

    const { result, parses } = await countParses(() => warm(repo));
    expect(result.analysis).toEqual({ reused: total - 1, analyzed: 1, statHits: total - 1, renamed: 0 });
    expect(parses).toBe(expected);
    await expectConverged(repo, result);
  });

  test("a renamed TypeScript file is not parsed at all", async () => {
    const { repo, total } = await setup();
    await mkdir(join(repo, "lib/renamed"), { recursive: true });
    await rename(join(repo, "src/logger.ts"), join(repo, "lib/renamed/log-output.ts"));
    const { result, parses } = await countParses(() => warm(repo));
    expect(result.analysis).toEqual({ reused: total, analyzed: 0, statHits: total - 1, renamed: 1 });
    expect(parses).toBe(0);
    await expectConverged(repo, result);
  });
});

describe("each version key invalidates the whole cache", () => {
  const changes: [string, (keys: VersionKeys) => VersionKeys][] = [
    ["store", (keys) => ({ ...keys, store: keys.store + 1 })],
    ["scope", (keys) => ({ ...keys, scope: `${keys.scope}-next` })],
    ["analyzer", (keys) => ({ ...keys, analyzer: "f".repeat(64) })],
    ["treeSitter", (keys) => ({ ...keys, treeSitter: `${keys.treeSitter}-next` })],
    [
      "grammars[tree-sitter-wasms]",
      (keys) => ({ ...keys, grammars: { ...keys.grammars, "tree-sitter-wasms": "0.0.0-next" } }),
    ],
    [
      "grammars[@tree-sitter-grammars/tree-sitter-yaml]",
      (keys) => ({ ...keys, grammars: { ...keys.grammars, "@tree-sitter-grammars/tree-sitter-yaml": "0.0.0-next" } }),
    ],
    ["an added grammar", (keys) => ({ ...keys, grammars: { ...keys.grammars, "tree-sitter-extra": "1.0.0" } })],
  ];

  async function integrity() {
    const loaded = await loadIntegrityKey();
    if (!("key" in loaded)) throw new Error("no integrity key in tests");
    return loaded.key;
  }

  /** Every document on disk is shaped as expected and every MAC verifies under `keys`. */
  async function expectSignedUnder(repo: string, keys: VersionKeys) {
    const secret = await integrity();
    expect((await readJson<{ keys: VersionKeys }>(join(storeDir(repo), "meta.json"))).keys).toEqual(keys);
    const names = await storeNames(repo);
    expect(names.filter((name) => !/^analysis-[0-9a-f]{2}\.json$/.test(name))).toEqual(["files.json", "meta.json"]);
    let entries = 0;
    for (const name of names.filter((name) => name.startsWith("analysis-"))) {
      const { schemaVersion, ...shard } = await readJson<{ schemaVersion: number; entries: object }>(
        join(storeDir(repo), name),
      );
      expect(schemaVersion).toBeGreaterThan(0);
      expect(isShard(shard, name.slice(0, -".json".length))).toBe(true);
      for (const [key, entry] of Object.entries((shard as { entries: Record<string, { mac: string }> }).entries)) {
        expect(entry.mac).toBe(entryMac(secret, keys, key, entry));
        entries++;
      }
    }
    expect(entries).toBeGreaterThan(0);
    const { schemaVersion, ...files } = await readJson<{ schemaVersion: number; files: Record<string, StoredRecord> }>(
      join(storeDir(repo), "files.json"),
    );
    expect(schemaVersion).toBeGreaterThan(0);
    expect(isFilesDocument(files)).toBe(true);
    for (const [path, { mac, ...fields }] of Object.entries(files.files)) {
      expect(mac).toBe(statMac(secret, keys, path, fields));
    }
    expect(Object.keys(files.files).length).toBeGreaterThan(0);
  }

  for (const [label, change] of changes) {
    test(`a changed ${label} rebuilds shards and stat records under the new keys`, async () => {
      const repo = await copyFixture("webhook-service");
      const keys = await currentVersionKeys();
      const changed = change(keys);
      expect(changed).not.toEqual(keys);

      const cold = await warm(repo, keys);
      const total = cold.analysis!.analyzed;
      await expectSignedUnder(repo, keys);

      const { result: rebuilt, parses } = await countParses(() => warm(repo, changed));
      expect(rebuilt.analysis).toEqual({ reused: 0, analyzed: total, statHits: 0, renamed: 0 });
      expect(parses).toBeGreaterThan(0);
      await expectConverged(repo, rebuilt);
      await expectSignedUnder(repo, changed);

      // The new records are trusted from here on: nothing is read again or parsed.
      const { result: again, parses: againParses } = await countParses(() => warm(repo, changed));
      expect(again.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
      expect(againParses).toBe(0);
      expect(again.warnings).toEqual(rebuilt.warnings);
    });

    test(`a changed ${label} discards old documents without reading them`, async () => {
      const repo = await copyFixture("webhook-service");
      const keys = await currentVersionKeys();
      const cold = await warm(repo, keys);
      // Documents from other versions are not even parsed, so damage in them is not reported.
      await truncate(join(storeDir(repo), "files.json"), 10);
      await truncate(join(storeDir(repo), (await shardNames(repo))[0]!), 10);
      const run = await warm(repo, change(keys));
      expect(run.analysis).toEqual({ reused: 0, analyzed: cold.analysis!.analyzed, statHits: 0, renamed: 0 });
      await expectConverged(repo, run);
      await expectSignedUnder(repo, change(keys));
    });

    test(`a rename is not reused across a changed ${label}`, async () => {
      const repo = await copyFixture("webhook-service");
      const keys = await currentVersionKeys();
      const cold = await warm(repo, keys);
      await mkdir(join(repo, "lib/renamed"), { recursive: true });
      await rename(join(repo, "src/logger.ts"), join(repo, "lib/renamed/log-output.ts"));
      // The old stat records no longer verify, so there is no old path to reuse an analysis from.
      const run = await warm(repo, change(keys));
      expect(run.analysis).toEqual({ reused: 0, analyzed: cold.analysis!.analyzed, statHits: 0, renamed: 0 });
      await expectConverged(repo, run);
    });
  }
});

describe("ignore rules are applied on every run", () => {
  const TARGET = "src/util/retry.ts";

  /**
   * Cold run, ignore `targets` with `ignore`, then unignore with `unignore`. Each warm run equals an uncached run;
   * ignored files leave the shards and the stat document; unignored ones are analyzed again. The ignore file is itself
   * a scanned text file: `existing` says whether it is already part of the cold run (then each rewrite re-analyzes
   * it) or is added by `ignore` and removed by `unignore`.
   */
  async function roundTrip(
    repo: string,
    targets: string[],
    ignore: () => Promise<void>,
    unignore: () => Promise<void>,
    existing: boolean,
  ) {
    const cold = await warm(repo);
    const total = cold.analysis!.analyzed;
    expect(Object.keys(await readRecords(repo))).toEqual(expect.arrayContaining(targets));
    expect(await storedPaths(repo)).toEqual(expect.arrayContaining(targets));
    const count = targets.length;
    const kept = total - count - (existing ? 1 : 0);

    await ignore();
    const ignored = await warm(repo);
    expect(ignored.chunks.filter((chunk) => targets.includes(chunk.file))).toEqual([]);
    expect(ignored.analysis).toEqual({ reused: kept, analyzed: 1, statHits: kept, renamed: 0 });
    await expectConverged(repo, ignored);
    for (const target of targets) {
      expect(Object.keys(await readRecords(repo))).not.toContain(target);
      expect(await storedPaths(repo)).not.toContain(target);
    }

    await unignore();
    const restored = await warm(repo);
    expect(restored.analysis).toEqual({
      reused: kept,
      analyzed: count + (existing ? 1 : 0),
      statHits: kept,
      renamed: 0,
    });
    expect(restored.chunks).toEqual(cold.chunks);
    await expectConverged(repo, restored);
    expect(Object.keys(await readRecords(repo))).toEqual(expect.arrayContaining(targets));
    expect((await warm(repo)).analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  }

  test("ignoring a file removes it and its records, and unignoring analyzes it again", async () => {
    const repo = await copyFixture("webhook-service");
    await writeFile(join(repo, ".gitignore"), "keep-me.txt\n");
    await roundTrip(
      repo,
      [TARGET],
      () => writeFile(join(repo, ".gitignore"), `keep-me.txt\n${TARGET}\n`),
      () => writeFile(join(repo, ".gitignore"), "keep-me.txt\n"),
      true,
    );
  });

  test("a nested .gitignore works the same way", async () => {
    const repo = await copyFixture("webhook-service");
    const nested = join(repo, "src/util/.gitignore");
    await roundTrip(
      repo,
      [TARGET],
      () => writeFile(nested, "retry.ts\n"),
      () => rm(nested),
      false,
    );
  });

  test("ignoring a directory removes every file in it, and unignoring analyzes them again", async () => {
    const repo = await copyFixture("webhook-service");
    const directory = "src/stripe";
    const targets = (await readdir(join(repo, directory))).map((name) => `${directory}/${name}`).sort();
    expect(targets.length).toBeGreaterThan(1);
    await writeFile(join(repo, ".gitignore"), "keep-me.txt\n");
    await roundTrip(
      repo,
      targets,
      () => writeFile(join(repo, ".gitignore"), `keep-me.txt\n${directory}/\n`),
      () => writeFile(join(repo, ".gitignore"), "keep-me.txt\n"),
      true,
    );
  });

  test("an ignored copy of a cached file is rename-reused or analyzed once unignored, with the same output", async () => {
    const repo = await copyFixture("webhook-service");
    await cp(join(repo, "src/logger.ts"), join(repo, "src/logger-copy.ts"));
    await writeFile(join(repo, ".gitignore"), "src/logger-copy.ts\n");
    const cold = await warm(repo);
    expect(cold.chunks.some((chunk) => chunk.file === "src/logger-copy.ts")).toBe(false);
    expect(Object.keys(await readRecords(repo))).not.toContain("src/logger-copy.ts");

    await rm(join(repo, ".gitignore"));
    const restored = await warm(repo);
    expect(restored.chunks.some((chunk) => chunk.file === "src/logger-copy.ts")).toBe(true);
    await expectConverged(repo, restored);
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, reused: restored.analysis!.reused });
  });

  test(".scope/ is never scanned, so the cache does not feed itself", async () => {
    const { repo, total } = await setup();
    const run = await warm(repo);
    expect(run.chunks.some((chunk) => chunk.file.startsWith(".scope"))).toBe(false);
    expect(run.analysis).toMatchObject({ analyzed: 0, reused: total });
  });
});

describe("corruption and partial writes give a safe rebuild", () => {
  /** After the corruption: one warning naming `document`, output equal to an uncached run, and a repair next run. */
  async function expectRepaired(
    repo: string,
    document: string,
    plain: Awaited<ReturnType<typeof loadChunks>>,
    total: number,
    broken: Awaited<ReturnType<typeof warm>>,
  ) {
    expect(broken.warnings.filter((warning) => warning.includes(document))).toHaveLength(1);
    expect(broken.chunks).toEqual(plain.chunks);
    expect(broken.warnings.filter((warning) => !warning.includes(document))).toEqual(plain.warnings);
    const repaired = await warm(repo);
    expect(repaired.warnings).toEqual(plain.warnings);
    expect(repaired.chunks).toEqual(plain.chunks);
    expect(repaired.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  }

  describe("a damaged shard", () => {
    for (const [label, cut] of [
      ["0 bytes", () => 0],
      ["20 bytes", () => 20],
      ["half its length", (size: number) => Math.floor(size / 2)],
    ] as const) {
      test(`truncated to ${label}`, async () => {
        const { repo, total } = await setup("mixed-app");
        const plain = await loadChunks(repo);
        const [victim] = await shardNames(repo);
        const path = join(storeDir(repo), victim!);
        await truncate(path, cut((await stat(path)).size));

        const broken = await warm(repo);
        expect(broken.analysis!.analyzed).toBeGreaterThan(0);
        expect(broken.analysis!.analyzed).toBeLessThan(total);
        await expectRepaired(repo, victim!, plain, total, broken);
      });
    }
  });

  describe("a damaged files document", () => {
    for (const [label, cut] of [
      ["half its length", (size: number) => Math.floor(size / 2)],
      ["0 bytes", () => 0],
    ] as const) {
      test(`truncated to ${label}, with a same-size edit that restores the mtime`, async () => {
        const { repo, total, cold } = await setup();
        const target = join(repo, "src/util/retry.ts");
        const original = await readFile(target, "utf8");
        const before = await stat(target);
        const edited = original.replace("baseDelayMs * 2 **", "baseDelayMs * 3 **");
        expect(edited).not.toBe(original);
        expect(edited.length).toBe(original.length);
        await writeFile(target, edited);
        await utimes(target, before.atime, before.mtime);
        const plain = await loadChunks(repo);
        // The edit is visible in the output, so serving the cached analysis would be stale output.
        expect(plain.chunks).not.toEqual(cold.chunks);

        const path = join(storeDir(repo), "files.json");
        await truncate(path, cut((await stat(path)).size));
        const broken = await warm(repo);
        expect(broken.chunks.some((chunk) => chunk.content.includes("baseDelayMs * 3 **"))).toBe(true);
        expect(broken.chunks.some((chunk) => chunk.content.includes("baseDelayMs * 2 **"))).toBe(false);
        // No stat record is usable, so every file is read and hashed; all but the edited one reuse through the hash.
        expect(broken.analysis).toEqual({ reused: total - 1, analyzed: 1, statHits: 0, renamed: 0 });
        await expectRepaired(repo, "files.json", plain, total, broken);
      });
    }
  });

  test("meta.json truncated makes the cache fresh: everything is reanalyzed and rewritten", async () => {
    const { repo, total } = await setup();
    const plain = await loadChunks(repo);
    // Edit a file so that a stale entry for its old content exists on disk.
    const edit = async (directory: string) => {
      const target = join(directory, "src/util/retry.ts");
      await writeFile(target, `${await readFile(target, "utf8")}\nexport const added = 1;\n`);
    };
    await edit(repo);
    const plainAfter = await loadChunks(repo);
    await truncate(join(storeDir(repo), "meta.json"), 5);

    const broken = await warm(repo);
    expect(broken.analysis).toEqual({ reused: 0, analyzed: total, statHits: 0, renamed: 0 });
    expect(broken.chunks).toEqual(plainAfter.chunks);
    expect(broken.chunks).not.toEqual(plain.chunks);
    expect(broken.warnings.filter((warning) => warning.includes("meta.json"))).toHaveLength(1);
    expect(broken.warnings.filter((warning) => !warning.includes("meta.json"))).toEqual(plainAfter.warnings);
    // The store holds exactly what a cold run on the edited tree writes: the stale entry is gone.
    const reference = await copyFixture("webhook-service", "reference");
    await edit(reference);
    await warm(reference);
    expect(await storeNames(repo)).toEqual(await storeNames(reference));
    expect(await entryKeys(repo)).toEqual(await entryKeys(reference));
    await readJson(join(storeDir(repo), "meta.json"));

    const repaired = await warm(repo);
    expect(repaired.warnings).toEqual(plainAfter.warnings);
    expect(repaired.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  });

  describe("a leftover temporary file from an interrupted write", () => {
    async function plant(repo: string) {
      const shard = (await shardNames(repo))[0]!;
      const text = await readFile(join(storeDir(repo), shard), "utf8");
      // The partial one is half of a real, valid shard; the other is empty (died before the first byte).
      const files = {
        old: [`.${shard.slice(0, -5)}.0123456789abcdef.tmp`, text.slice(0, Math.floor(text.length / 2))],
        oldEmpty: [".files.fedcba9876543210.tmp", ""],
        young: [".analysis-zz.aaaaaaaaaaaaaaaa.tmp", "{"],
      } as const;
      const aged = new Date(Date.now() - 2 * TMP_MAX_AGE_MS);
      for (const [name, content] of Object.values(files)) {
        await writeFile(join(storeDir(repo), name), content);
      }
      await utimes(join(storeDir(repo), files.old[0]), aged, aged);
      await utimes(join(storeDir(repo), files.oldEmpty[0]), aged, aged);
      return { old: files.old[0], oldEmpty: files.oldEmpty[0], young: files.young[0] };
    }

    test("is never read, and the next commit sweeps it once it is old enough", async () => {
      const { repo, total } = await setup();
      const plain = await loadChunks(repo);
      const tmps = await plant(repo);

      const untouched = await warm(repo);
      expect(untouched.warnings).toEqual(plain.warnings);
      expect(untouched.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });

      // A change makes the run commit, which sweeps stale temporaries and leaves a recent one (a live write).
      const target = join(repo, "src/util/retry.ts");
      await writeFile(target, `${await readFile(target, "utf8")}\nexport const added = 1;\n`);
      const run = await warm(repo);
      expect(run.analysis).toEqual({ reused: total - 1, analyzed: 1, statHits: total - 1, renamed: 0 });
      await expectConverged(repo, run);
      const names = await storeNames(repo);
      expect(names).not.toContain(tmps.old);
      expect(names).not.toContain(tmps.oldEmpty);
      expect(names).toContain(tmps.young);
    });

    test("does not stand in for a missing document", async () => {
      const { repo, total } = await setup();
      const plain = await loadChunks(repo);
      const tmps = await plant(repo);
      // The real shard and the files document are gone; only the leftovers remain.
      const shard = (await shardNames(repo))[0]!;
      await rm(join(storeDir(repo), shard));
      await rm(join(storeDir(repo), "files.json"));
      const run = await warm(repo);
      expect(run.warnings).toEqual(plain.warnings);
      expect(run.chunks).toEqual(plain.chunks);
      expect(run.analysis!.analyzed).toBeGreaterThan(0);
      expect(run.analysis!.statHits).toBe(0);
      expect(await storeNames(repo)).not.toContain(tmps.old);
      expect((await warm(repo)).analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
    });
  });

  describe("a shard replaced by something that is not a regular file", () => {
    test("a symlink to a valid-looking file outside the store is not read through", async () => {
      const { repo, total } = await setup("mixed-app");
      const plain = await loadChunks(repo);
      const [victim] = await shardNames(repo);
      const path = join(storeDir(repo), victim!);
      // The outside file holds the real, correctly signed shard: following the link would reuse it.
      const outside = join(tmp, "outside-shard.json");
      const content = await readFile(path, "utf8");
      await writeFile(outside, content);
      await rm(path);
      await symlink(outside, path);

      const broken = await warm(repo);
      expect(broken.analysis!.analyzed).toBeGreaterThan(0);
      expect(broken.analysis!.analyzed).toBeLessThan(total);
      await expectRepaired(repo, victim!, plain, total, broken);
      expect(await readFile(outside, "utf8")).toBe(content);
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
    });

    test("a directory in its place is not read, the output is correct and the outcome is reported", async () => {
      const { repo, total } = await setup("mixed-app");
      const plain = await loadChunks(repo);
      const [victim] = await shardNames(repo);
      const path = join(storeDir(repo), victim!);
      await rm(path);
      await mkdir(join(path, "inner"), { recursive: true });

      const broken = await warm(repo);
      expect(broken.chunks).toEqual(plain.chunks);
      expect(broken.analysis!.analyzed).toBeGreaterThan(0);
      expect(broken.analysis!.analyzed).toBeLessThan(total);
      // A commit cannot rename a file over a directory, so the cache stays unwritten: it warns, and stays safe.
      const cacheWarnings = (run: typeof broken) =>
        run.warnings.filter((warning) => warning.includes(victim!) || warning.startsWith("cache not written"));
      expect(cacheWarnings(broken).length).toBeGreaterThan(0);
      expect(broken.warnings.filter((warning) => !cacheWarnings(broken).includes(warning))).toEqual(plain.warnings);
      // The directory is never treated as data, and a later run still produces correct output.
      const next = await warm(repo);
      expect(next.chunks).toEqual(plain.chunks);
      expect(next.analysis!.analyzed).toBeGreaterThan(0);
    });
  });

  test("a deleted store directory gives a fresh, correct run that rebuilds the cache", async () => {
    const { repo, total } = await setup();
    const plain = await loadChunks(repo);
    await rm(storeDir(repo), { recursive: true });
    const fresh = await warm(repo);
    expect(fresh.warnings).toEqual(plain.warnings);
    expect(fresh.chunks).toEqual(plain.chunks);
    expect(fresh.analysis).toEqual({ reused: 0, analyzed: total, statHits: 0, renamed: 0 });
    expect((await warm(repo)).analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  });

  test("a deleted .scope directory gives a fresh, correct run that rebuilds the cache", async () => {
    const { repo, total } = await setup();
    const plain = await loadChunks(repo);
    await rm(join(repo, ".scope"), { recursive: true });
    const fresh = await warm(repo);
    expect(fresh.warnings).toEqual(plain.warnings);
    expect(fresh.analysis).toEqual({ reused: 0, analyzed: total, statHits: 0, renamed: 0 });
    expect((await warm(repo)).analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  });
});
