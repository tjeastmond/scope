import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisKey, isShard } from "../src/cache/analysis.ts";
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
        entries: Record<string, { path: string; chunks: { endLine?: number; file: string }[] }>;
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
      expect(warm.analysis).toEqual({ reused: cold.analysis!.analyzed, analyzed: 0 });
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
  expect(after.analysis).toEqual({ reused: first.analysis!.analyzed - 1, analyzed: 0 });
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
    expect(repaired.analysis).toEqual({ reused: cold.analysis!.analyzed, analyzed: 0 });
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
      await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 1, ...doc }));

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
    for (const entry of Object.values(doc.entries)) {
      entry.path = "other.ts";
      for (const chunk of entry.chunks) chunk.file = "other.ts";
    }
    await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 1, ...doc }));
    const run = await loadChunks(repo, { cache: {} });
    expect(run.analysis!.analyzed).toBe(Object.keys(doc.entries).length);
    expect(run.chunks).toEqual((await loadChunks(repo)).chunks);
    // The replaced entry was written, so the next run reuses it.
    expect((await loadChunks(repo, { cache: {} })).analysis!.analyzed).toBe(0);
  });

  const plant = async (repo: string, change: (chunk: Record<string, unknown>) => void) => {
    const shards = await readShards(repo);
    const { name, doc } = shards.find(({ doc }) => Object.values(doc.entries).some((e) => e.chunks.length > 0))!;
    const entry = Object.values(doc.entries).find((e) => e.chunks.length > 0)!;
    change(entry.chunks[0] as unknown as Record<string, unknown>);
    await writeFile(join(storeDir(repo), name), JSON.stringify({ schemaVersion: 1, ...doc }));
    return entry.path;
  };

  for (const [label, change] of [
    ["edited content", (chunk: Record<string, unknown>) => (chunk.content = "INJECTED_CONTENT_4d2a")],
    ["a wrong id", (chunk: Record<string, unknown>) => (chunk.id = "badbadbadbad")],
    ["an endLine past the source", (chunk: Record<string, unknown>) => (chunk.endLine = 99999)],
    ["a parentId outside the entry", (chunk: Record<string, unknown>) => (chunk.parentId = "nosuchparent")],
  ] as const) {
    test(`a shape-valid entry with ${label} is a miss, replaced and then reused`, async () => {
      const repo = await copyFixture("webhook-service");
      const plain = await loadChunks(repo);
      await loadChunks(repo, { cache: {} });
      await plant(repo, change);
      const run = await loadChunks(repo, { cache: {} });
      expect(run.analysis!.analyzed).toBe(1);
      expect(run.chunks).toEqual(plain.chunks);
      expect(run.warnings).toEqual(plain.warnings);
      expect(JSON.stringify(await readShards(repo))).not.toContain("INJECTED_CONTENT_4d2a");
      expect((await loadChunks(repo, { cache: {} })).analysis!.analyzed).toBe(0);
    });
  }

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
  expect(rebuilt.analysis).toEqual({ reused: 0, analyzed: first.analysis!.analyzed });
  expect(rebuilt.chunks).toEqual(first.chunks);
  // The old keys now miss too: the store was rebuilt for the new ones.
  const back = await loadChunks(repo, { cache: { keys } });
  expect(back.analysis!.reused).toBe(0);
  const meta = JSON.parse(await readFile(join(storeDir(repo), "meta.json"), "utf8")) as { keys: VersionKeys };
  expect(meta.keys).toEqual(keys);
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
    entries: { [key]: { path: "a.ts", chunks: [chunk], warnings: [], textOnly: false, ...overrides } },
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
