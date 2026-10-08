import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisKey, isShard } from "../src/cache/analysis.ts";
import { entryMac, loadIntegrityKey } from "../src/cache/integrity.ts";
import { makeChunkId } from "../src/chunk-id.ts";
import type { CodeChunk } from "../src/types.ts";
import { currentVersionKeys, type VersionKeys } from "../src/cache/versions.ts";
import { main, type Io } from "../src/main.ts";
import { loadChunks, runScope } from "../src/scope.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const TASK = "retry handling for invoice reminders";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-analysis-cache-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function copyFixture(name: string): Promise<string> {
  const repo = join(tmp, name);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const shardFiles = async (repo: string) =>
  (await readdir(storeDir(repo))).filter((name) => name.startsWith("analysis-")).sort();
const readShards = async (repo: string) =>
  Promise.all(
    (await shardFiles(repo)).map(async (name) => ({
      name,
      doc: JSON.parse(await readFile(join(storeDir(repo), name), "utf8")) as {
        entries: Record<string, { path: string; chunks: { endLine?: number; file: string }[]; mac: string }>;
      },
    })),
  );
const pathsInShards = async (repo: string) =>
  (await readShards(repo)).flatMap(({ doc }) => Object.values(doc.entries).map((entry) => entry.path));

/** Every file under a directory with its modification time, for "nothing was written". */
async function snapshot(directory: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const entry of await readdir(directory, { recursive: true })) {
    result[entry] = (await stat(join(directory, entry))).mtimeMs;
  }
  return result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cold/warm equivalence", () => {
  for (const name of ["mixed-app", "webhook-service"]) {
    test(`${name}: cold, warm and uncached runs agree and the warm run reuses everything`, async () => {
      const repo = await copyFixture(name);
      const plain = await loadChunks(repo);
      const cold = await loadChunks(repo, { cache: {} });
      const warm = await loadChunks(repo, { cache: {} });
      expect(cold.chunks).toEqual(plain.chunks);
      expect(cold.warnings).toEqual(plain.warnings);
      expect(warm.chunks).toEqual(plain.chunks);
      expect(warm.warnings).toEqual(plain.warnings);
      expect(cold.analysis?.reused).toBe(0);
      expect(cold.analysis!.analyzed).toBeGreaterThan(0);
      expect(warm.analysis).toMatchObject({ reused: cold.analysis!.analyzed, analyzed: 0 });
    });
  }

  test("mixed-app has text-only and partly parsed files, so the warnings are exercised", async () => {
    const repo = await copyFixture("mixed-app");
    const warm = (await loadChunks(repo, { cache: {} }), await loadChunks(repo, { cache: {} }));
    expect(warm.warnings.some((warning) => warning.includes("no analyzer"))).toBe(true);
  });

  test("a partly parsed file keeps its warning when reused", async () => {
    const repo = await copyFixture("webhook-service");
    await writeFile(join(repo, "src/broken.ts"), "export function ok() { return 1; }\nexport function (((\n");
    const plain = await loadChunks(repo);
    expect(plain.warnings.some((warning) => warning.startsWith("src/broken.ts"))).toBe(true);
    await loadChunks(repo, { cache: {} });
    const warm = await loadChunks(repo, { cache: {} });
    expect(warm.warnings).toEqual(plain.warnings);
    expect(warm.chunks).toEqual(plain.chunks);
    expect(warm.analysis!.analyzed).toBe(0);
  });
});

test("a changed file is reanalyzed and its old entry is gone", async () => {
  const repo = await copyFixture("webhook-service");
  await loadChunks(repo, { cache: {} });
  const target = "src/util/retry.ts";
  const oldKey = analysisKey(target, await readFile(join(repo, target)));
  await writeFile(join(repo, target), `${await readFile(join(repo, target), "utf8")}\nexport const added = 1;\n`);
  const after = await loadChunks(repo, { cache: {} });
  expect(after.analysis!.analyzed).toBe(1);
  expect(after.chunks).toEqual((await loadChunks(repo)).chunks);
  const keys = (await readShards(repo)).flatMap(({ doc }) => Object.keys(doc.entries));
  expect(keys).not.toContain(oldKey);
  expect(keys).toContain(analysisKey(target, await readFile(join(repo, target))));
  expect((await pathsInShards(repo)).filter((path) => path === target)).toHaveLength(1);
});

test("a stale key is removed from a shard that still holds live entries", async () => {
  const repo = await copyFixture("webhook-service");
  const byShard = new Map<string, string[]>();
  for (let i = 0; i < 300; i++) {
    const path = `gen/f${i}.ts`;
    const text = `export const v${i} = ${i};\n`;
    await mkdir(join(repo, "gen"), { recursive: true });
    await writeFile(join(repo, path), text);
    const prefix = analysisKey(path, Buffer.from(text)).slice(0, 2);
    byShard.set(prefix, [...(byShard.get(prefix) ?? []), path]);
  }
  await loadChunks(repo, { cache: {} });
  const [prefix, paths] = [...byShard].find(([, list]) => list.length >= 2)!;
  const target = paths[0]!;
  const oldKey = analysisKey(target, await readFile(join(repo, target)));
  // With 300 generated files, some shard holds two or more entries (asserted by the find above).
  await writeFile(join(repo, target), "export const edited = true;\n");
  const after = await loadChunks(repo, { cache: {} });
  expect(after.analysis!.analyzed).toBe(1);
  const shard = (await readShards(repo)).find(({ name }) => name === `analysis-${prefix}.json`)!;
  expect(Object.keys(shard.doc.entries).length).toBeGreaterThanOrEqual(1);
  expect(Object.keys(shard.doc.entries)).not.toContain(oldKey);
  expect(Object.keys(shard.doc.entries)).toContain(analysisKey(paths[1]!, await readFile(join(repo, paths[1]!))));
});

test("a deleted file's entry is pruned", async () => {
  const repo = await copyFixture("webhook-service");
  const first = await loadChunks(repo, { cache: {} });
  const target = "src/util/retry.ts";
  expect(await pathsInShards(repo)).toContain(target);
  await rm(join(repo, target));
  const after = await loadChunks(repo, { cache: {} });
  expect(after.analysis).toMatchObject({ reused: first.analysis!.analyzed - 1, analyzed: 0 });
  expect(await pathsInShards(repo)).not.toContain(target);
});

test("a warm run with no changes writes nothing", async () => {
  const repo = await copyFixture("mixed-app");
  await loadChunks(repo, { cache: {} });
  const before = await snapshot(join(repo, ".scope"));
  await sleep(30);
  const warm = await loadChunks(repo, { cache: {} });
  expect(warm.analysis!.analyzed).toBe(0);
  expect(await snapshot(join(repo, ".scope"))).toEqual(before);
});

describe("unusable shards", () => {
  test("a truncated shard warns, its files are reanalyzed and the next commit repairs it", async () => {
    const repo = await copyFixture("mixed-app");
    const plain = await loadChunks(repo);
    const cold = await loadChunks(repo, { cache: {} });
    const [victim] = await shardFiles(repo);
    const victimPath = join(storeDir(repo), victim!);
    await truncate(victimPath, 20);

    const broken = await loadChunks(repo, { cache: {} });
    expect(broken.warnings.filter((warning) => warning.includes(victim!))).toHaveLength(1);
    expect(broken.analysis!.analyzed).toBeGreaterThan(0);
    expect(broken.analysis!.analyzed).toBeLessThan(cold.analysis!.analyzed);
    expect(broken.chunks).toEqual(plain.chunks);
    expect(broken.warnings.filter((warning) => !warning.includes(victim!))).toEqual(plain.warnings);

    const rewritten = await readFile(victimPath, "utf8");
    expect(() => JSON.parse(rewritten)).not.toThrow();
    const repaired = await loadChunks(repo, { cache: {} });
    expect(repaired.warnings).toEqual(plain.warnings);
    expect(repaired.analysis).toMatchObject({ reused: cold.analysis!.analyzed, analyzed: 0 });
  });

  for (const [label, tamper] of [
    ["a chunk without endLine", (entry: { chunks: { endLine?: number }[] }) => delete entry.chunks[0]!.endLine],
    [
      "a chunk whose file differs from the entry path",
      (entry: { chunks: { file: string }[] }) => {
        entry.chunks[0]!.file = "elsewhere.ts";
      },
    ],
  ] as const) {
    test(`shape validation rejects ${label}`, async () => {
      const repo = await copyFixture("webhook-service");
      const plain = await loadChunks(repo);
      await loadChunks(repo, { cache: {} });
      const shards = await readShards(repo);
      const { name, doc } = shards.find(({ doc }) =>
        Object.values(doc.entries).some((entry) => entry.chunks.length > 0),
      )!;
      const entry = Object.values(doc.entries).find((candidate) => candidate.chunks.length > 0)!;
      (tamper as (e: typeof entry) => void)(entry);
      await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 2, ...doc }));

      const run = await loadChunks(repo, { cache: {} });
      expect(run.warnings.some((warning) => warning.includes(name))).toBe(true);
      expect(run.analysis!.analyzed).toBeGreaterThan(0);
      expect(run.chunks).toEqual(plain.chunks);
    });
  }

  test("an entry whose path differs from the file being loaded is a miss", async () => {
    const repo = await copyFixture("webhook-service");
    await loadChunks(repo, { cache: {} });
    const shards = await readShards(repo);
    const { name, doc } = shards[0]!;
    const integrity = await loadIntegrityKey();
    if (!("key" in integrity)) throw new Error("no integrity key in tests");
    for (const [entryKey, entry] of Object.entries(doc.entries)) {
      entry.path = "other.ts";
      // Ids recomputed for the new path and content unchanged, so only the path check can reject the entry.
      for (const chunk of entry.chunks) {
        chunk.file = "other.ts";
        const typed = chunk as unknown as CodeChunk;
        typed.id = makeChunkId(typed);
        for (const reference of typed.references) reference.from.file = "other.ts";
      }
      // The MAC is recomputed under the real key, so only the path check can reject the entry.
      (entry as { mac?: string }).mac = entryMac(integrity.key, await currentVersionKeys(), entryKey, entry);
    }
    await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 2, ...doc }));
    const run = await loadChunks(repo, { cache: {} });
    expect(run.analysis!.analyzed).toBe(Object.keys(doc.entries).length);
    expect(run.chunks).toEqual((await loadChunks(repo)).chunks);
    // The replaced entry was written, so the next run reuses it.
    expect((await loadChunks(repo, { cache: {} })).analysis!.analyzed).toBe(0);
  });

  type Loose = Record<string, unknown> & { references: Record<string, unknown>[] };
  type Planted = { path: string; chunks: Loose[]; warnings: string[]; mac: string };

  /** Applies `change` to the first stored entry that has a chunk, keeping its old MAC, and writes the shard back. */
  const plant = async (repo: string, change: (entry: Planted, key: string) => void) => {
    for (const { name, doc } of await readShards(repo)) {
      const entries = doc.entries as unknown as Record<string, Planted>;
      const key = Object.keys(entries).find((k) => entries[k]!.chunks.length > 0);
      if (!key) continue;
      change(entries[key]!, key);
      await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 2, ...doc }));
      return entries[key]!.path;
    }
    throw new Error("no entry with chunks to plant into");
  };

  // Every planted change keeps the entry's old MAC, so only the MAC check can reject it.
  const planted: [string, (entry: Planted) => void][] = [
    ["edited chunk content", (entry) => (entry.chunks[0]!.content = "injectedmarkerzq")],
    [
      "a name rebuilt from source words (id recomputed)",
      (entry) => {
        entry.chunks[0]!.name = "injectedmarkerzq";
        entry.chunks[0]!.id = makeChunkId(entry.chunks[0] as unknown as CodeChunk);
      },
    ],
    ["its chunks deleted", (entry) => (entry.chunks = [])],
    ["an added warning with the path prefix", (entry) => entry.warnings.push(`${entry.path}: injectedmarkerzq`)],
  ];
  for (const [label, change] of planted) {
    test(`a shape-valid entry with ${label} keeps its old MAC, is a miss, is replaced and then reused`, async () => {
      const repo = await copyFixture("mixed-app");
      const plain = await loadChunks(repo);
      const cold = await loadChunks(repo, { cache: {} });
      await plant(repo, change);
      const run = await loadChunks(repo, { cache: {} });
      expect(run.analysis).toMatchObject({ reused: cold.analysis!.analyzed - 1, analyzed: 1 });
      expect(run.chunks).toEqual(plain.chunks);
      expect(run.warnings).toEqual(plain.warnings);
      expect(JSON.stringify(await readShards(repo))).not.toContain("injectedmarkerzq");
      expect((await loadChunks(repo, { cache: {} })).analysis!.analyzed).toBe(0);
    });
  }

  test("an entry whose MAC was computed for another entry key is a miss", async () => {
    const repo = await copyFixture("webhook-service");
    await loadChunks(repo, { cache: {} });
    const path = "src/logger.ts";
    const oldBytes = await readFile(join(repo, path));
    const oldKey = analysisKey(path, oldBytes);
    const oldEntry = (await readShards(repo))
      .map(({ doc }) => doc.entries[oldKey])
      .find((entry) => entry !== undefined);
    expect(oldEntry).toBeDefined();
    // Edit the file, then store the old, genuinely MACed entry (old content too) in the slot of the new key.
    await writeFile(join(repo, path), `${oldBytes.toString("utf8")}\n// edited\n`);
    const newKey = analysisKey(path, await readFile(join(repo, path)));
    const shardPath = join(storeDir(repo), `analysis-${newKey.slice(0, 2)}.json`);
    const existing = await readFile(shardPath, "utf8").then(
      (text) => JSON.parse(text) as { entries: Record<string, unknown> },
      () => ({ entries: {} as Record<string, unknown> }),
    );
    existing.entries[newKey] = oldEntry;
    await writeFile(shardPath, JSON.stringify({ schemaVersion: 2, ...existing }));
    const plain = await loadChunks(repo);
    const run = await loadChunks(repo, { cache: {} });
    expect(run.analysis!.analyzed).toBe(1);
    expect(run.chunks).toEqual(plain.chunks);
    expect(run.warnings).toEqual(plain.warnings);
    expect(JSON.stringify(await readShards(repo))).not.toContain("// edited");
    expect((await loadChunks(repo, { cache: {} })).analysis!.analyzed).toBe(0);
  });

  test("a cache built under another user's key is rebuilt, not trusted", async () => {
    const repo = await copyFixture("mixed-app");
    const stateX = await mkdtemp(join(tmpdir(), "scope-key-x-"));
    const stateY = await mkdtemp(join(tmpdir(), "scope-key-y-"));
    try {
      const plain = await loadChunks(repo);
      const underX = await loadChunks(repo, { cache: { integrityEnv: { XDG_STATE_HOME: stateX } } });
      expect((await loadChunks(repo, { cache: { integrityEnv: { XDG_STATE_HOME: stateX } } })).analysis!.analyzed).toBe(
        0,
      );
      const total = underX.analysis!.analyzed;
      const underY = await loadChunks(repo, { cache: { integrityEnv: { XDG_STATE_HOME: stateY } } });
      expect(underY.analysis).toMatchObject({ reused: 0, analyzed: total });
      expect(underY.chunks).toEqual(plain.chunks);
      expect(underY.warnings).toEqual(plain.warnings);
      const again = await loadChunks(repo, { cache: { integrityEnv: { XDG_STATE_HOME: stateY } } });
      expect(again.analysis).toMatchObject({ reused: total, analyzed: 0 });
    } finally {
      await rm(stateX, { recursive: true, force: true });
      await rm(stateY, { recursive: true, force: true });
    }
  });

  test("cached content holding a redacted literal is not reused; the output has the redacted form", async () => {
    const repo = await copyFixture("webhook-service");
    const literal = "sk-proj-abcdefghijklmnopqrstuv";
    await writeFile(join(repo, "src/k.ts"), `export const key = "${literal}";\n`);
    const plain = await loadChunks(repo);
    expect(JSON.stringify(plain.chunks)).not.toContain(literal);
    await loadChunks(repo, { cache: {} });
    const key = analysisKey("src/k.ts", await readFile(join(repo, "src/k.ts")));
    const shardPath = join(storeDir(repo), `analysis-${key.slice(0, 2)}.json`);
    const doc = JSON.parse(await readFile(shardPath, "utf8"));
    doc.entries[key].chunks[0].content = `export const key = "${literal}";`;
    await writeFile(shardPath, JSON.stringify(doc));
    const run = await loadChunks(repo, { cache: {} });
    expect(run.analysis!.analyzed).toBe(1);
    expect(JSON.stringify(run.chunks)).not.toContain(literal);
    expect(run.chunks).toEqual(plain.chunks);
    expect(JSON.stringify(await readShards(repo))).not.toContain(literal);
  });
});

test("a changed version key rebuilds everything and does not reuse old shards", async () => {
  const repo = await copyFixture("webhook-service");
  const keys = await currentVersionKeys();
  const changed: VersionKeys = { ...keys, analyzer: "f".repeat(64) };
  const first = await loadChunks(repo, { cache: { keys } });
  const rebuilt = await loadChunks(repo, { cache: { keys: changed } });
  expect(rebuilt.analysis).toMatchObject({ reused: 0, analyzed: first.analysis!.analyzed });
  expect(rebuilt.chunks).toEqual(first.chunks);
  // The old keys now miss too: the store was rebuilt for the new ones.
  const back = await loadChunks(repo, { cache: { keys } });
  expect(back.analysis!.reused).toBe(0);
  const meta = JSON.parse(await readFile(join(storeDir(repo), "meta.json"), "utf8")) as { keys: VersionKeys };
  expect(meta.keys).toEqual(keys);
});

test("shards signed under old version keys are not reused when meta.json is rewritten to the current keys", async () => {
  const repo = await copyFixture("webhook-service");
  const keys = await currentVersionKeys();
  const old: VersionKeys = { ...keys, analyzer: "f".repeat(64) };
  await loadChunks(repo, { cache: { keys: old } });
  const oldShards = await Promise.all(
    (await shardFiles(repo)).map(async (name) => [name, await readFile(join(storeDir(repo), name), "utf8")] as const),
  );
  const current = await loadChunks(repo, { cache: { keys } });
  expect(current.analysis!.reused).toBe(0);
  // Replay: the shards signed under the old keys come back, while meta.json already names the current keys.
  for (const [name, text] of oldShards) await writeFile(join(storeDir(repo), name), text);
  const replayed = await loadChunks(repo, { cache: { keys } });
  expect(replayed.analysis).toMatchObject({ reused: 0, analyzed: current.analysis!.analyzed });
  expect(replayed.chunks).toEqual(current.chunks);
  expect((await loadChunks(repo, { cache: { keys } })).analysis!.analyzed).toBe(0);
});

test("excluded, secret and binary content never reaches the cache", async () => {
  const repo = await copyFixture("webhook-service");
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await cp(join(repo, "src"), join(repo, "ignored"), { recursive: true });
  await writeFile(join(repo, "ignored/mod.ts"), "export const ignoredNote = 'IGNORED_MARKER_7f3a';\n");
  await writeFile(join(repo, ".env.production"), "TOKEN=ENV_MARKER_91c2\n");
  await writeFile(
    join(repo, "blob.ts"),
    Buffer.from(`export const x = 'BINARY_MARKER_55d1';\n${"// padding\n".repeat(1000)}\0`),
  );
  await writeFile(
    join(repo, "src/keys.ts"),
    'export const kept = "KEPT_MARKER_0b4e";\nexport const key = "sk-proj-abcdefghijklmnopqrstuv";\n',
  );
  const run = await loadChunks(repo, { cache: {} });
  expect(run.warnings.some((warning) => warning.includes("blob.ts"))).toBe(true);
  const all = (
    await Promise.all(
      (await readdir(join(repo, ".scope"), { recursive: true })).map(async (entry) => {
        const path = join(repo, ".scope", entry);
        return (await stat(path)).isFile() ? readFile(path, "utf8") : "";
      }),
    )
  ).join("\n");
  expect(all).toContain("KEPT_MARKER_0b4e");
  for (const marker of ["IGNORED_MARKER_7f3a", "ENV_MARKER_91c2", "BINARY_MARKER_55d1", "abcdefghijklmnopqrstuv"]) {
    expect(all).not.toContain(marker);
  }
  expect(await pathsInShards(repo)).not.toContain("blob.ts");
});

test("with the cache off nothing is written into the repository", async () => {
  const repo = await copyFixture("webhook-service");
  await loadChunks(repo);
  await runScope({ task: TASK, repo, noJev: true });
  expect(await readdir(repo)).not.toContain(".scope");
  await runScope({ task: TASK, repo, noJev: true, cache: true });
  expect(await readdir(repo)).toContain(".scope");
});

describe("the CLI", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
    return { io, stdout: () => out.join(""), stderr: () => err.join("") };
  }
  const saved = process.env.SCOPE_CACHE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCOPE_CACHE;
    else process.env.SCOPE_CACHE = saved;
  });

  async function cli(repo: string, env: string | undefined, ...flags: string[]) {
    if (env === undefined) delete process.env.SCOPE_CACHE;
    else process.env.SCOPE_CACHE = env;
    const run = capture();
    expect(await main([TASK, "--repo", repo, "--no-jev", ...flags], run.io)).toBe(0);
    return run;
  }

  test("caches by default; --no-cache and SCOPE_CACHE=off write nothing; the output never changes", async () => {
    const cached = await copyFixture("mixed-app");
    const cold = await cli(cached, undefined);
    expect((await readdir(storeDir(cached))).length).toBeGreaterThan(0);
    const warm = await cli(cached, undefined);

    const flagged = join(tmp, "flagged");
    await cp(join(FIXTURES, "mixed-app"), flagged, { recursive: true });
    const noCache = await cli(flagged, undefined, "--no-cache");
    expect(await readdir(flagged)).not.toContain(".scope");

    const envOff = join(tmp, "env-off");
    await cp(join(FIXTURES, "mixed-app"), envOff, { recursive: true });
    const off = await cli(envOff, "off");
    expect(await readdir(envOff)).not.toContain(".scope");

    expect(warm.stdout()).toBe(cold.stdout());
    expect(noCache.stdout()).toBe(cold.stdout());
    expect(off.stdout()).toBe(cold.stdout());
    expect(warm.stderr()).toBe(noCache.stderr());
  });

  test("any other SCOPE_CACHE value leaves the cache on", async () => {
    const repo = await copyFixture("webhook-service");
    await cli(repo, "on");
    expect(await readdir(repo)).toContain(".scope");
  });

  test("--help documents --no-cache", async () => {
    const run = capture();
    await main(["--help"], run.io);
    expect(run.stdout()).toContain("--no-cache");
  });
});

describe("isShard", () => {
  const key = "ab".padEnd(64, "0");
  const chunk = {
    id: "c1",
    file: "a.ts",
    language: "typescript",
    kind: "function",
    name: "f",
    startLine: 1,
    endLine: 2,
    content: "x",
    references: [{ kind: "call", from: { file: "a.ts", line: 1 }, name: "g" }],
  };
  const shard = (overrides: Record<string, unknown> = {}) => ({
    entries: {
      [key]: { path: "a.ts", chunks: [chunk], warnings: [], textOnly: false, mac: "ab".repeat(32), ...overrides },
    },
  });

  test("accepts a well-formed shard", () => {
    expect(isShard(shard())).toBe(true);
    expect(isShard({ entries: {} })).toBe(true);
  });

  test("rejects a wrong type in a reference", () => {
    const bad = { ...chunk, references: [{ ...chunk.references[0], name: 7 }] };
    expect(isShard(shard({ chunks: [bad] }))).toBe(false);
    const badFrom = { ...chunk, references: [{ ...chunk.references[0], from: { file: "a.ts", line: "1" } }] };
    expect(isShard(shard({ chunks: [badFrom] }))).toBe(false);
  });

  test("rejects a missing or invalid endLine", () => {
    const withoutEnd: Record<string, unknown> = { ...chunk };
    delete withoutEnd.endLine;
    expect(isShard(shard({ chunks: [withoutEnd] }))).toBe(false);
    expect(isShard(shard({ chunks: [{ ...chunk, endLine: "2" }] }))).toBe(false);
    expect(isShard(shard({ chunks: [{ ...chunk, endLine: 0 }] }))).toBe(false);
  });

  test("rejects a key that belongs to another shard", () => {
    expect(isShard(shard(), "analysis-ab")).toBe(true);
    expect(isShard(shard(), "analysis-cd")).toBe(false);
  });

  test("rejects a non-integer line", () => {
    expect(isShard(shard({ chunks: [{ ...chunk, startLine: 1.5 }] }))).toBe(false);
  });

  test("rejects extra garbage", () => {
    expect(isShard({ entries: { nothex: shard().entries[key] } })).toBe(false);
    expect(isShard({ entries: shard().entries, extra: 1 })).toBe(false);
    expect(isShard(shard({ extra: true }))).toBe(false);
    expect(isShard(shard({ chunks: [{ ...chunk, extra: 1 }] }))).toBe(false);
    expect(isShard(shard({ textOnly: "no" }))).toBe(false);
    expect(isShard(shard({ warnings: [1] }))).toBe(false);
  });

  test("rejects a chunk whose file differs from the entry path, or an unknown kind", () => {
    expect(isShard(shard({ chunks: [{ ...chunk, file: "b.ts" }] }))).toBe(false);
    expect(isShard(shard({ chunks: [{ ...chunk, kind: "bogus" }] }))).toBe(false);
  });
});
