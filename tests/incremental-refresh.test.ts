import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analysisKey, contentHash, isFilesDocument, RACY_MARGIN_MS } from "../src/cache/analysis.ts";
import { entryMac, loadIntegrityKey, statMac, type StatFields } from "../src/cache/integrity.ts";
import { currentVersionKeys, type VersionKeys } from "../src/cache/versions.ts";
import { loadChunks } from "../src/scope.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-incremental-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function copyFixture(name: string): Promise<string> {
  const repo = join(tmp, name);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

/** Records are taken an hour "later" than the files were written, so none is racy unless a test says so. */
const later = () => Date.now() + HOUR;
const warm = (repo: string, extra: { now?: () => number; racyMarginMs?: number; keys?: VersionKeys } = {}) =>
  loadChunks(repo, { cache: { now: later, ...extra } });

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
type StoredRecord = StatFields & { mac: string };
const readRecords = async (repo: string): Promise<Record<string, StoredRecord>> =>
  (JSON.parse(await readFile(join(storeDir(repo), "files.json"), "utf8")) as { files: Record<string, StoredRecord> })
    .files;
const writeRecords = (repo: string, files: Record<string, StoredRecord>) =>
  writeFile(join(storeDir(repo), "files.json"), JSON.stringify({ schemaVersion: 1, files }));
const shardTexts = async (repo: string) => {
  const names = (await readdir(storeDir(repo))).filter((name) => name.startsWith("analysis-"));
  return new Map<string, string>(
    await Promise.all(names.map(async (name) => [name, await readFile(join(storeDir(repo), name), "utf8")] as const)),
  );
};
const storedPaths = async (repo: string) =>
  [...(await shardTexts(repo)).values()].flatMap((text) =>
    Object.values((JSON.parse(text) as { entries: Record<string, { path: string }> }).entries).map((e) => e.path),
  );
/** Gives every file the same modification time, so tests do not depend on when the fixture files were written. */
async function touchAll(repo: string, when: Date) {
  for (const entry of await readdir(repo, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), when, when);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A warm run must equal an uncached run on the same tree, chunks and warnings alike. */
async function expectConverged(repo: string, run: Awaited<ReturnType<typeof warm>>) {
  const plain = await loadChunks(repo);
  expect(run.chunks).toEqual(plain.chunks);
  expect(run.warnings).toEqual(plain.warnings);
}

async function setup(name: string) {
  const repo = await copyFixture(name);
  const cold = await warm(repo);
  const total = cold.analysis!.analyzed;
  expect(total).toBeGreaterThan(5);
  expect(cold.analysis).toMatchObject({ reused: 0, statHits: 0, renamed: 0 });
  return { repo, total };
}

describe("edit, add and delete", () => {
  test("an edited file is analyzed and every other file is a stat hit", async () => {
    const { repo, total } = await setup("webhook-service");
    const target = "src/util/retry.ts";
    await writeFile(join(repo, target), `${await readFile(join(repo, target), "utf8")}\nexport const added = 1;\n`);
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total - 1, analyzed: 1, statHits: total - 1, renamed: 0 });
    await expectConverged(repo, run);
    expect((await warm(repo)).analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  });

  test("an added file is analyzed and every other file is a stat hit", async () => {
    const { repo, total } = await setup("webhook-service");
    await writeFile(join(repo, "src/extra.ts"), "export function extra() { return 42; }\n");
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total, analyzed: 1, statHits: total, renamed: 0 });
    await expectConverged(repo, run);
    expect(Object.keys(await readRecords(repo))).toContain("src/extra.ts");
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, statHits: total + 1 });
  });

  test("a deleted file loses its entry and its stat record", async () => {
    const { repo, total } = await setup("webhook-service");
    const target = "src/util/retry.ts";
    expect(Object.keys(await readRecords(repo))).toContain(target);
    await rm(join(repo, target));
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total - 1, analyzed: 0, statHits: total - 1, renamed: 0 });
    await expectConverged(repo, run);
    expect(Object.keys(await readRecords(repo))).not.toContain(target);
    expect(Object.keys(await readRecords(repo))).toHaveLength(total - 1);
    expect(await storedPaths(repo)).not.toContain(target);
  });

  test("deleting every analyzable file removes the stat document", async () => {
    const { repo } = await setup("webhook-service");
    await rm(join(repo, "src"), { recursive: true });
    await rm(join(repo, "tests"), { recursive: true });
    const run = await warm(repo);
    expect(run.chunks).toEqual([]);
    expect(await readdir(storeDir(repo))).not.toContain("files.json");
  });
});

describe("renames", () => {
  test("identical bytes at a new path in another directory reuse the old analysis", async () => {
    const { repo, total } = await setup("webhook-service");
    await mkdir(join(repo, "lib/renamed"), { recursive: true });
    await rename(join(repo, "src/logger.ts"), join(repo, "lib/renamed/log-output.ts"));
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total, analyzed: 0, statHits: total - 1, renamed: 1 });
    await expectConverged(repo, run);
    const records = Object.keys(await readRecords(repo));
    expect(records).toContain("lib/renamed/log-output.ts");
    expect(records).not.toContain("src/logger.ts");
    expect(await storedPaths(repo)).not.toContain("src/logger.ts");
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, statHits: total, renamed: 0 });
  });

  test("a file copied to a new path reuses the analysis and the original stays cached", async () => {
    const { repo, total } = await setup("webhook-service");
    await cp(join(repo, "src/logger.ts"), join(repo, "src/logger-copy.ts"));
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total + 1, analyzed: 0, statHits: total, renamed: 1 });
    await expectConverged(repo, run);
  });

  test("a rename that changes .ts to .tsx is analyzed, not reused", async () => {
    const { repo, total } = await setup("webhook-service");
    await rename(join(repo, "src/logger.ts"), join(repo, "src/logger.tsx"));
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total - 1, analyzed: 1, statHits: total - 1, renamed: 0 });
    await expectConverged(repo, run);
  });

  test("a rename that changes the extension to another language is analyzed, not reused", async () => {
    const { repo, total } = await setup("webhook-service");
    await rename(join(repo, "src/logger.ts"), join(repo, "src/logger.js"));
    const run = await warm(repo);
    expect(run.analysis).toMatchObject({ analyzed: 1, renamed: 0, reused: total - 1 });
    await expectConverged(repo, run);
  });
});

describe("a branch switch", () => {
  test("edits, deletions, additions, renames and a swap converge to the uncached result", async () => {
    const { repo, total } = await setup("mixed-app");
    const text = async (path: string) => readFile(join(repo, path), "utf8");
    const swapA = "api/src/util/format.ts";
    const swapB = "web/src/lib/format.ts";
    const renames: [string, string][] = [
      ["worker/format.py", "worker/lib/render_output.py"],
      ["api/src/util/csv.ts", "api/src/util/exports/rows.ts"],
    ];
    const deleted = ["api/src/routes/health.ts", "worker/names.py", "db/migrations/002_add_status_index.sql"];
    const reserved = new Set([swapA, swapB, ...renames.map(([from]) => from), ...deleted]);
    const comment: Record<string, string> = { ".ts": "//", ".tsx": "//", ".py": "#" };
    const editable = (await readdir(repo, { recursive: true }))
      .filter((path) => !reserved.has(path) && !path.includes("test") && comment[path.slice(path.lastIndexOf("."))])
      .sort();
    const edited = editable.filter((_, index) => index % 2 === 0);
    expect(edited.length).toBeGreaterThan(4);

    const [a, b] = [await text(swapA), await text(swapB)];
    expect(a).not.toBe(b);
    for (const path of edited) {
      await writeFile(
        join(repo, path),
        `${await text(path)}\n${comment[path.slice(path.lastIndexOf("."))]} edited ${path}\n`,
      );
    }
    for (const [from, to] of renames) {
      await mkdir(dirname(join(repo, to)), { recursive: true });
      await rename(join(repo, from), join(repo, to));
    }
    for (const path of deleted) await rm(join(repo, path));
    await writeFile(join(repo, swapA), b);
    await writeFile(join(repo, swapB), a);
    const added = ["api/src/added/one.ts", "api/src/added/two.ts", "worker/added.py", "web/src/added/Three.tsx"];
    await mkdir(join(repo, "api/src/added"), { recursive: true });
    await mkdir(join(repo, "web/src/added"), { recursive: true });
    await writeFile(join(repo, added[0]!), "export const one = 1;\n");
    await writeFile(join(repo, added[1]!), "export function two() { return 2; }\n");
    await writeFile(join(repo, added[2]!), "def added():\n    return 3\n");
    await writeFile(join(repo, added[3]!), "export const Three = () => <p>three</p>;\n");

    const run = await warm(repo);
    const now = total - deleted.length + added.length;
    expect(run.analysis).toMatchObject({
      analyzed: edited.length + added.length,
      renamed: 4,
      reused: now - edited.length - added.length,
    });
    await expectConverged(repo, run);
    expect(await storedPaths(repo)).not.toEqual(expect.arrayContaining(deleted));
    for (const [from] of renames) expect(Object.keys(await readRecords(repo))).not.toContain(from);
    expect(Object.keys(await readRecords(repo))).toHaveLength(now);

    const again = await warm(repo);
    expect(again.analysis).toEqual({ reused: now, analyzed: 0, statHits: now, renamed: 0 });
    await expectConverged(repo, again);
  });
});

describe("the stat fast path", () => {
  test("a warm run with no changes reads no analyzable file", async () => {
    const { repo, total } = await setup("mixed-app");
    const run = await warm(repo);
    expect(run.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
    await expectConverged(repo, run);
  });

  test("a same-size edit with the modification time restored is caught by the change time", async () => {
    const { repo, total } = await setup("webhook-service");
    const target = "src/util/retry.ts";
    const before = await stat(join(repo, target));
    const original = await readFile(join(repo, target), "utf8");
    const changed = original.replace(/function (\w)/, "function Z");
    expect(changed).not.toBe(original);
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await sleep(20);
    await writeFile(join(repo, target), changed);
    await utimes(join(repo, target), before.atime, before.mtime);
    const run = await warm(repo);
    expect(run.analysis).toMatchObject({ statHits: total - 1 });
    await expectConverged(repo, run);
  });

  test("a file inside the racy margin is read and hashed, then trusted once the margin has passed", async () => {
    const repo = await copyFixture("webhook-service");
    const written = new Date("2030-01-01T00:00:00Z");
    await touchAll(repo, written);
    const at = (ms: number) => () => written.getTime() + ms;
    const first = await warm(repo, { now: at(500) });
    const total = first.analysis!.analyzed;
    // The records were taken half a second after the files were written, so none may be trusted.
    const second = await warm(repo, { now: at(10_000) });
    expect(second.analysis).toEqual({ reused: total, analyzed: 0, statHits: 0, renamed: 0 });
    await expectConverged(repo, second);
    // That run took fresh records, ten seconds after the writes, which are trusted.
    const third = await warm(repo, { now: at(20_000) });
    expect(third.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
  });

  test("the racy margin is a parameter and defaults to two seconds", async () => {
    expect(RACY_MARGIN_MS).toBe(2000);
    const repo = await copyFixture("webhook-service");
    await touchAll(repo, new Date());
    const total = (await warm(repo)).analysis!.analyzed;
    expect((await warm(repo, { racyMarginMs: 2 * HOUR })).analysis).toMatchObject({ statHits: 0, analyzed: 0 });
    expect((await warm(repo, { racyMarginMs: 0 })).analysis).toMatchObject({ statHits: total });
  });

  test("a changed version key discards the stat records", async () => {
    const repo = await copyFixture("webhook-service");
    const keys = await currentVersionKeys();
    const first = await warm(repo, { keys });
    const total = first.analysis!.analyzed;
    const changed = await warm(repo, { keys: { ...keys, analyzer: "f".repeat(64) } });
    expect(changed.analysis).toMatchObject({ analyzed: total, statHits: 0, reused: 0 });
    expect((await warm(repo, { keys: { ...keys, analyzer: "f".repeat(64) } })).analysis).toMatchObject({
      statHits: total,
    });
  });
});

describe("planted and altered stat records are not trusted", () => {
  const TARGET = "src/util/retry.ts";
  const EDIT = "\nexport function addedByTheEdit() { return 1; }\n";

  /**
   * Cache the original file, edit it, and cache the edit. Then put the original's shards back, so a genuinely signed
   * entry for the old bytes exists. A record that is trusted wrongly would serve that stale analysis.
   */
  async function stale() {
    const { repo, total } = await setup("webhook-service");
    const originalBytes = await readFile(join(repo, TARGET));
    const originalRecord = (await readRecords(repo))[TARGET]!;
    const shards = await shardTexts(repo);
    await writeFile(join(repo, TARGET), Buffer.concat([originalBytes, Buffer.from(EDIT)]));
    await warm(repo);
    for (const [name, text] of shards) await writeFile(join(storeDir(repo), name), text);
    const info = await stat(join(repo, TARGET));
    const actual = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
      recordedAt: Date.now() + HOUR,
    };
    const staleFields = { key: analysisKey(TARGET, originalBytes), hash: contentHash(originalBytes) };
    const keys = await currentVersionKeys();
    const integrity = await loadIntegrityKey();
    if (!("key" in integrity)) throw new Error("no integrity key in tests");
    const sign = (fields: StatFields, secret = integrity.key): StoredRecord => ({
      ...fields,
      mac: statMac(secret, keys, TARGET, fields),
    });
    const plant = async (record: StoredRecord) => {
      await writeRecords(repo, { ...(await readRecords(repo)), [TARGET]: record });
    };
    return { repo, total, actual, staleFields, originalRecord, sign, plant, keys };
  }

  /** The planted record is not used: the file is read, the output is the uncached output, and the commit repairs it. */
  async function expectRejected(repo: string, total: number) {
    const run = await warm(repo);
    expect(run.analysis).toMatchObject({ statHits: total - 1 });
    await expectConverged(repo, run);
    expect(run.chunks.some((chunk) => chunk.name === "addedByTheEdit")).toBe(true);
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, statHits: total });
  }

  test("control: a correctly signed record that matches the file is trusted, so the stale analysis is observable", async () => {
    const { repo, total, actual, staleFields, sign, plant } = await stale();
    await plant(sign({ ...actual, ...staleFields }));
    const run = await warm(repo);
    expect(run.analysis).toMatchObject({ analyzed: 0, statHits: total });
    expect(run.chunks.some((chunk) => chunk.name === "addedByTheEdit")).toBe(false);
  });

  for (const field of ["size", "mtimeMs", "ctimeMs", "ino"] as const) {
    test(`a signed record whose ${field} differs is not a stat hit`, async () => {
      const { repo, total, actual, staleFields, sign, plant } = await stale();
      await plant(sign({ ...actual, [field]: actual[field] + 1, ...staleFields }));
      await expectRejected(repo, total);
    });
  }

  test("a record taken less than the racy margin after the modification time is not a stat hit", async () => {
    const { repo, total, actual, staleFields, sign, plant } = await stale();
    await plant(sign({ ...actual, ...staleFields, recordedAt: actual.mtimeMs + RACY_MARGIN_MS - 1 }));
    await expectRejected(repo, total);
  });

  test("a record taken exactly the racy margin after the modification time is trusted", async () => {
    const { repo, total, actual, staleFields, sign, plant } = await stale();
    await plant(sign({ ...actual, ...staleFields, recordedAt: actual.mtimeMs + RACY_MARGIN_MS }));
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, statHits: total });
  });

  /** Backdates the target's mtime by an hour, which moves its ctime to now, and returns the fresh stat fields. */
  async function backdated(repo: string) {
    const old = new Date(Date.now() - HOUR);
    await utimes(join(repo, TARGET), old, old);
    const info = await stat(join(repo, TARGET));
    expect(info.ctimeMs - info.mtimeMs).toBeGreaterThan(RACY_MARGIN_MS);
    return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
  }

  test("a record taken less than the racy margin after the change time is not a stat hit, even with an old mtime", async () => {
    const { repo, total, staleFields, sign, plant } = await stale();
    const fields = await backdated(repo);
    await plant(sign({ ...fields, ...staleFields, recordedAt: fields.ctimeMs + RACY_MARGIN_MS - 1 }));
    await expectRejected(repo, total);
  });

  test("a record taken the racy margin after the change time of a backdated file is trusted", async () => {
    const { repo, total, staleFields, sign, plant } = await stale();
    const fields = await backdated(repo);
    await plant(sign({ ...fields, ...staleFields, recordedAt: fields.ctimeMs + RACY_MARGIN_MS }));
    expect((await warm(repo)).analysis).toMatchObject({ analyzed: 0, statHits: total });
  });

  test("a record with the old MAC and recomputed fields is rejected", async () => {
    const { repo, total, actual, staleFields, originalRecord, plant } = await stale();
    await plant({ ...actual, ...staleFields, mac: originalRecord.mac });
    await expectRejected(repo, total);
  });

  test("a record signed with another user's key is rejected", async () => {
    const { repo, total, actual, staleFields, sign, plant } = await stale();
    const other = await mkdtemp(join(tmpdir(), "scope-key-other-"));
    try {
      const integrity = await loadIntegrityKey({ XDG_STATE_HOME: other });
      if (!("key" in integrity)) throw new Error("no key");
      await plant(sign({ ...actual, ...staleFields }, integrity.key));
      await expectRejected(repo, total);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("a record signed under older version keys is rejected", async () => {
    const { repo, total, actual, staleFields, plant, keys } = await stale();
    const integrity = await loadIntegrityKey();
    if (!("key" in integrity)) throw new Error("no key");
    const fields = { ...actual, ...staleFields };
    await plant({ ...fields, mac: statMac(integrity.key, { ...keys, analyzer: "e".repeat(64) }, TARGET, fields) });
    await expectRejected(repo, total);
  });

  test("a record carrying an analysis entry's MAC is rejected", async () => {
    const { repo, total, actual, staleFields, plant } = await stale();
    const shard = JSON.parse((await shardTexts(repo)).get(`analysis-${staleFields.key.slice(0, 2)}.json`)!) as {
      entries: Record<string, { mac: string }>;
    };
    await plant({ ...actual, ...staleFields, mac: shard.entries[staleFields.key]!.mac });
    await expectRejected(repo, total);
  });

  test("a record pointing at another file's valid key is rejected", async () => {
    const { repo, total, actual, sign, plant } = await stale();
    const other = "src/logger.ts";
    const bytes = await readFile(join(repo, other));
    await plant(sign({ ...actual, key: analysisKey(other, bytes), hash: contentHash(bytes) }));
    await expectRejected(repo, total);
  });

  test("a record that is not valid JSON in shape discards the whole document and the next run repairs it", async () => {
    const { repo, total } = await setup("webhook-service");
    await writeFile(
      join(storeDir(repo), "files.json"),
      JSON.stringify({ schemaVersion: 1, files: { "a.ts": { size: "1" } } }),
    );
    const run = await warm(repo);
    expect(run.warnings.some((warning) => warning.includes("files.json"))).toBe(true);
    expect(run.analysis).toMatchObject({ analyzed: 0, statHits: 0, reused: total });
    await expectConverged(repo, {
      ...run,
      warnings: run.warnings.filter((warning) => !warning.includes("files.json")),
    });
    expect((await warm(repo)).analysis).toMatchObject({ statHits: total });
  });
});

describe("the stat MAC and the entry MAC", () => {
  const key = Buffer.alloc(32, 7);
  const versions = { a: "1" };
  const fields: StatFields = {
    size: 10,
    mtimeMs: 1.5,
    ctimeMs: 2.5,
    ino: 3,
    key: "a".repeat(64),
    hash: "b".repeat(64),
    recordedAt: 99,
  };

  test("a stat MAC never equals an entry MAC over the same data, in either direction", () => {
    const asEntry = { path: "a.ts", ...fields };
    expect(statMac(key, versions, "a.ts", fields)).not.toBe(entryMac(key, versions, fields.key, asEntry));
    expect(statMac(key, versions, "a.ts", fields)).not.toBe(entryMac(key, versions, "files", { path: "a.ts" }));
    expect(entryMac(key, versions, "a.ts", fields)).not.toBe(statMac(key, versions, "a.ts", fields));
  });

  test("the stat MAC covers every field, the path, the version keys and the key", () => {
    const base = statMac(key, versions, "a.ts", fields);
    expect(statMac(key, versions, "a.ts", { ...fields })).toBe(base);
    for (const change of [
      { size: 11 },
      { mtimeMs: 1.6 },
      { ctimeMs: 2.6 },
      { ino: 4 },
      { key: "c".repeat(64) },
      { hash: "d".repeat(64) },
      { recordedAt: 100 },
    ]) {
      expect(statMac(key, versions, "a.ts", { ...fields, ...change })).not.toBe(base);
    }
    expect(statMac(key, versions, "b.ts", fields)).not.toBe(base);
    expect(statMac(key, { a: "2" }, "a.ts", fields)).not.toBe(base);
    expect(statMac(Buffer.alloc(32, 8), versions, "a.ts", fields)).not.toBe(base);
  });
});

describe("isFilesDocument", () => {
  const record = {
    size: 1,
    mtimeMs: 1.5,
    ctimeMs: 2,
    ino: 3,
    key: "a".repeat(64),
    hash: "b".repeat(64),
    recordedAt: 4,
    mac: "c".repeat(64),
  };
  test("accepts a well-formed document and rejects malformed ones", () => {
    expect(isFilesDocument({ files: {} })).toBe(true);
    expect(isFilesDocument({ files: { "a.ts": record } })).toBe(true);
    expect(isFilesDocument({ files: { "a.ts": { ...record, size: -1 } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, size: 1.5 } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, mtimeMs: "1" } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, mtimeMs: Number.NaN } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, key: "xyz" } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, extra: 1 } } })).toBe(false);
    expect(isFilesDocument({ files: { "a.ts": { ...record, mac: undefined } } })).toBe(false);
    expect(isFilesDocument({ files: {}, extra: 1 })).toBe(false);
    expect(isFilesDocument({ files: [] })).toBe(false);
  });
});
