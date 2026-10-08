import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheStatus, clearCache, formatBytes, rebuildCache } from "../src/cache/controls.ts";
import { integrityKeyPath } from "../src/cache/integrity.ts";
import { DEFAULT_RETENTION, resolveRetention } from "../src/cache/retention.ts";
import { DocumentStore, type DocumentType } from "../src/cache/store.ts";
import { currentVersionKeys, type VersionKeys } from "../src/cache/versions.ts";
import { UsageError } from "../src/errors.ts";
import { main, parseCli, type Io } from "../src/main.ts";
import { loadChunks } from "../src/scope.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;

let tmp: string;
const savedCache = process.env.SCOPE_CACHE;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-controls-"));
  delete process.env.SCOPE_CACHE;
});
afterEach(async () => {
  if (savedCache === undefined) delete process.env.SCOPE_CACHE;
  else process.env.SCOPE_CACHE = savedCache;
  await rm(tmp, { recursive: true, force: true });
});

async function copyFixture(name = "webhook-service"): Promise<string> {
  const repo = join(tmp, name);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

/** Records are taken an hour "later" than the files were written, so none is racy. */
const later = () => Date.now() + HOUR;
const warm = (repo: string, keys?: VersionKeys) => loadChunks(repo, { cache: { now: later, keys } });
const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const storeNames = async (repo: string) => (await readdir(storeDir(repo))).sort();
const shardNames = async (repo: string) => (await storeNames(repo)).filter((name) => name.startsWith("analysis-"));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function cli(...argv: string[]) {
  const run = capture();
  const code = await main(argv, run.io);
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

/** Every path under `directory` with its size, for before/after comparisons. */
async function tree(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(`${path}/`, ...(await tree(join(directory, entry.name), `${path}/`)));
    else found.push(`${path}:${(await stat(join(directory, entry.name))).size}`);
  }
  return found.sort();
}

async function keySnapshot() {
  const path = integrityKeyPath()!;
  const info = await stat(path);
  return { bytes: (await readFile(path)).toString("hex"), mtimeMs: info.mtimeMs };
}

describe("parsing", () => {
  test("each subcommand parses", () => {
    expect(parseCli(["cache", "status"])).toMatchObject({ kind: "cache", action: "status", format: "text" });
    expect(parseCli(["cache", "status", "--format", "json"])).toMatchObject({ action: "status", format: "json" });
    expect(parseCli(["cache", "rebuild", "--repo", FIXTURES])).toMatchObject({ action: "rebuild" });
    expect(parseCli(["cache", "clear", "--yes"])).toMatchObject({ action: "clear", yes: true });
    expect(parseCli(["cache", "--help"])).toMatchObject({ kind: "cache", help: true });
    expect(parseCli(["cache", "-h"])).toMatchObject({ kind: "cache", help: true });
  });

  test("scope cache alone or with an unknown subcommand is a usage error listing the subcommands", () => {
    for (const argv of [["cache"], ["cache", "purge"], ["cache", "--repo", FIXTURES]]) {
      expect(() => parseCli(argv)).toThrow(UsageError);
      expect(() => parseCli(argv)).toThrow(/status, clear, rebuild/);
    }
  });

  test("extra positionals, unknown flags and task flags are rejected", () => {
    expect(() => parseCli(["cache", "status", "extra"])).toThrow(UsageError);
    expect(() => parseCli(["cache", "status", "--bogus"])).toThrow(UsageError);
    for (const flag of ["--output", "--explain", "--no-jev", "--no-cache"]) {
      const argv = ["cache", "status", flag, ...(flag === "--output" ? ["x"] : [])];
      expect(() => parseCli(argv)).toThrow(/applies to a task run/);
    }
    expect(() => parseCli(["cache", "rebuild", "--format", "json"])).toThrow(/only applies to scope cache status/);
    expect(() => parseCli(["cache", "clear", "--yes", "--format", "json"])).toThrow(
      /only applies to scope cache status/,
    );
    expect(() => parseCli(["cache", "status", "--format", "markdown"])).toThrow(/text or json/);
    expect(() => parseCli(["cache", "status", "--yes"])).toThrow(/only applies to scope cache clear/);
    expect(() => parseCli(["cache", "status", "--repo", join(tmp, "missing")])).toThrow(UsageError);
  });

  test("clear without --yes is a usage error that deletes nothing", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const before = await tree(join(repo, ".scope"));
    const result = await cli("cache", "clear", "--repo", repo);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("rerun with --yes to confirm");
    expect(await tree(join(repo, ".scope"))).toEqual(before);
  });

  test("scope -- cache still runs a task named cache; run options are unchanged", () => {
    expect(parseCli(["--", "cache"])).toMatchObject({ kind: "run", task: "cache" });
    expect(parseCli(["fix the bug", "--no-jev"])).toMatchObject({ kind: "run", task: "fix the bug", noJev: true });
    expect(() => parseCli(["fix it", "--yes"])).toThrow(UsageError);
  });
});

describe("status", () => {
  test("without .scope reports nothing and creates nothing", async () => {
    const repo = await copyFixture();
    const before = await tree(repo);
    const status = await cacheStatus(repo);
    expect(status.exists).toBe(false);
    expect(status.versions.state).toBe("no metadata");
    expect(status.lastUpdated).toBeUndefined();
    const text = await cli("cache", "status", "--repo", repo);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("not present");
    expect(await tree(repo)).toEqual(before);
  });

  test("a warm cache reports counts that match what was written", async () => {
    const repo = await copyFixture();
    const run = await warm(repo);
    const before = await tree(repo);
    const status = await cacheStatus(repo);
    const shards = await shardNames(repo);
    let entries = 0;
    for (const name of shards) {
      entries += Object.keys(JSON.parse(await readFile(join(storeDir(repo), name), "utf8")).entries).length;
    }
    const records = Object.keys(JSON.parse(await readFile(join(storeDir(repo), "files.json"), "utf8")).files).length;
    expect(status.exists).toBe(true);
    expect(status.documents).toEqual({
      total: (await storeNames(repo)).filter((name) => name.endsWith(".json")).length,
      unreadable: [],
      analysisShards: shards.length,
      analysisEntries: entries,
      statRecords: records,
    });
    expect(entries).toBe(run.analysis!.analyzed);
    expect(status.versions).toEqual({ state: "current", differing: [] });
    expect(status.sizeBytes).toBeGreaterThan(0);
    expect(status.lastUpdated).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(status.retention.bounds).toEqual(DEFAULT_RETENTION);

    const json = await cli("cache", "status", "--repo", repo, "--format", "json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(status)));
    const text = await cli("cache", "status", "--repo", repo);
    expect(text.stdout).toContain(`${entries} entries in ${shards.length} shards`);
    expect(text.stdout).toContain("versions:      current");
    expect(await tree(repo)).toEqual(before);
  });

  test("a stale cache names the keys that differ", async () => {
    const repo = await copyFixture();
    const current = await currentVersionKeys();
    await warm(repo, { ...current, scope: "0.0.0-old" });
    const status = await cacheStatus(repo);
    expect(status.versions).toEqual({ state: "stale", differing: ["scope"] });
    expect((await cli("cache", "status", "--repo", repo)).stdout).toContain("stale: scope differ");
  });

  test("a corrupt shard is reported as unreadable and the command still succeeds", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const [shard] = await shardNames(repo);
    await writeFile(join(storeDir(repo), shard!), "{ not json");
    const status = await cacheStatus(repo);
    expect(status.documents.unreadable).toEqual([shard!.replace(".json", "")]);
    expect((await cli("cache", "status", "--repo", repo)).code).toBe(0);
  });

  test("a corrupt meta is reported as unreadable, with no version state", async () => {
    const repo = await copyFixture();
    await warm(repo);
    await writeFile(join(storeDir(repo), "meta.json"), "{ not json");
    const status = await cacheStatus(repo);
    expect(status.documents.unreadable).toEqual(["meta"]);
    expect(status.versions.state).toBe("no metadata");
    expect(status.lastUpdated).toBeUndefined();
  });

  test("other store majors are listed with their size", async () => {
    const repo = await copyFixture();
    await mkdir(join(repo, ".scope/store-v9"), { recursive: true });
    await writeFile(join(repo, ".scope/store-v9/meta.json"), "12345");
    const status = await cacheStatus(repo);
    expect(status.exists).toBe(false);
    expect(status.otherStores).toEqual([{ name: "store-v9", sizeBytes: 5, size: "5 B" }]);
  });

  test("a symlinked .scope fails with exit 1 and is not followed", async () => {
    const repo = await copyFixture();
    const outside = join(tmp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "x");
    await symlink(outside, join(repo, ".scope"));
    const result = await cli("cache", "status", "--repo", repo);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("symbolic link");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  test("shows retention warnings on stderr without failing", async () => {
    const repo = await copyFixture();
    process.env.SCOPE_HISTORY_MAX_RUNS = "-1";
    try {
      const result = await cli("cache", "status", "--repo", repo);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("SCOPE_HISTORY_MAX_RUNS");
    } finally {
      delete process.env.SCOPE_HISTORY_MAX_RUNS;
    }
  });
});

describe("clear", () => {
  test("removes the documents, keeps .gitignore, and the next run is cold and equal to an uncached run", async () => {
    const repo = await copyFixture();
    const first = await warm(repo);
    const total = first.analysis!.analyzed;
    const bytes = (await cacheStatus(repo)).sizeBytes;
    const result = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed");
    const summary = await clearCache(repo); // second clear: nothing left to remove
    expect(summary.stores.reduce((sum, store) => sum + store.documents, 0)).toBe(0);
    expect(await readdir(join(repo, ".scope"))).toEqual([".gitignore"]);
    expect(bytes).toBeGreaterThan(0);

    const status = await cacheStatus(repo);
    expect(status.exists).toBe(false);
    expect(status.documents.total).toBe(0);

    const again = await warm(repo);
    expect(again.analysis!.analyzed).toBe(total);
    const plain = await loadChunks(repo);
    expect(again.chunks).toEqual(plain.chunks);
    expect(again.warnings).toEqual(plain.warnings);
  });

  test("reports documents removed and bytes freed", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const before = await cacheStatus(repo);
    const result = await clearCache(repo);
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0]!.documents).toBe(before.documents.total);
    expect(result.stores[0]!.bytes).toBe(before.sizeBytes);
  });

  test("with no .scope it succeeds and says there was nothing to clear", async () => {
    const repo = await copyFixture();
    const before = await tree(repo);
    const result = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nothing to clear");
    expect(await tree(repo)).toEqual(before);
  });

  test("refuses a symlinked .scope and leaves the outside files byte for byte", async () => {
    const repo = await copyFixture();
    const outside = join(tmp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "meta.json"), '{"schemaVersion":1}');
    await mkdir(join(outside, "store-v1"));
    await writeFile(join(outside, "store-v1/files.json"), "precious");
    await symlink(outside, join(repo, ".scope"));
    const before = await tree(outside);
    const result = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing to follow");
    expect(await tree(outside)).toEqual(before);
    expect(await readFile(join(outside, "store-v1/files.json"), "utf8")).toBe("precious");
  });

  test("refuses a symlinked store directory and deletes nothing, not even other stores", async () => {
    const repo = await copyFixture();
    await mkdir(join(repo, ".scope/store-v0"), { recursive: true });
    await writeFile(join(repo, ".scope/store-v0/meta.json"), "{}");
    const outside = join(tmp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "files.json"), "precious");
    await writeFile(join(outside, "other.txt"), "also precious");
    await symlink(outside, join(repo, ".scope/store-v1"));
    const result = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(result.code).not.toBe(0);
    expect(await tree(outside)).toEqual(["files.json:8", "other.txt:13"]);
    expect(await readFile(join(repo, ".scope/store-v0/meta.json"), "utf8")).toBe("{}");
  });

  test("leaves files Scope did not create, warns about them, and touches nothing else", async () => {
    const repo = await copyFixture();
    await warm(repo);
    await writeFile(join(storeDir(repo), "notes.txt"), "mine");
    await writeFile(join(storeDir(repo), "Weird.json"), "{}");
    await mkdir(join(storeDir(repo), "subdir"));
    await writeFile(join(repo, ".scope/extra.txt"), "elsewhere");
    await writeFile(join(repo, "README.local"), "repo file");
    const result = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(result.code).toBe(0);
    expect(await storeNames(repo)).toEqual(["Weird.json", "notes.txt", "subdir"]);
    for (const name of ["notes.txt", "Weird.json", "subdir"]) expect(result.stderr).toContain(`store-v1/${name}`);
    expect(await readFile(join(repo, ".scope/extra.txt"), "utf8")).toBe("elsewhere");
    expect(await readFile(join(repo, "README.local"), "utf8")).toBe("repo file");
    expect(await readFile(join(repo, ".scope/.gitignore"), "utf8")).toBe("*\n");
  });

  test("removes the store directory itself when nothing else is in it", async () => {
    const repo = await copyFixture();
    await warm(repo);
    await clearCache(repo);
    expect(await readdir(join(repo, ".scope"))).toEqual([".gitignore"]);
  });

  test("removes leftover data temp files from interrupted writes, even fresh ones", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const temp = join(storeDir(repo), ".files.0123456789abcdef.tmp");
    await writeFile(temp, "half a write");
    const result = await clearCache(repo);
    expect(result.stores[0]!.tempFiles).toBe(1);
    expect(await readdir(join(repo, ".scope"))).toEqual([".gitignore"]);
  });

  test("fails and deletes nothing while another process holds the lock", async () => {
    const repo = await copyFixture();
    await warm(repo);
    await writeFile(join(storeDir(repo), "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const before = await tree(storeDir(repo));
    await expect(clearCache(repo, { lockWaitMs: 100 })).rejects.toThrow(/Nothing was deleted/);
    expect(await tree(storeDir(repo))).toEqual(before);
  });
});

describe("rebuild", () => {
  test("reparses everything, equals an uncached run, and the next run is all stat hits", async () => {
    const repo = await copyFixture();
    const first = await warm(repo);
    const total = first.analysis!.analyzed;
    const result = await rebuildCache(repo, { now: later });
    expect(result.filesAnalyzed).toBe(total);
    expect(result.committed).toBe(true);
    const next = await warm(repo);
    expect(next.analysis).toEqual({ reused: total, analyzed: 0, statHits: total, renamed: 0 });
    const plain = await loadChunks(repo);
    expect(next.chunks).toEqual(plain.chunks);
    expect(result.chunks).toBe(plain.chunks.length);
  });

  test("ignores a fully warm cache: nothing is reused, no stat hit", async () => {
    const repo = await copyFixture();
    const first = await warm(repo);
    const rebuilt = await loadChunks(repo, { cache: { now: later, rebuild: true } });
    expect(rebuilt.analysis).toEqual({ reused: 0, analyzed: first.analysis!.analyzed, statHits: 0, renamed: 0 });
  });

  test("repairs a corrupted shard", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const [shard] = await shardNames(repo);
    await truncate(join(storeDir(repo), shard!), 5);
    expect((await cacheStatus(repo)).documents.unreadable).toHaveLength(1);
    await rebuildCache(repo, { now: later });
    expect((await cacheStatus(repo)).documents.unreadable).toEqual([]);
  });

  test("works on a repository with no cache yet", async () => {
    const repo = await copyFixture();
    const result = await cli("cache", "rebuild", "--repo", repo);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Rebuilt the analysis cache: \d+ files analyzed, \d+ chunks/);
    expect((await cacheStatus(repo)).documents.analysisEntries).toBeGreaterThan(0);
  });

  test("with SCOPE_CACHE=off it is a usage error", async () => {
    const repo = await copyFixture();
    process.env.SCOPE_CACHE = "off";
    const result = await cli("cache", "rebuild", "--repo", repo);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the cache is off (SCOPE_CACHE=off)");
    await expect(readdir(join(repo, ".scope"))).rejects.toThrow();
  });

  test("leaves an unrelated document in the store untouched", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const history: DocumentType<{ runs: number[] }> = {
      name: "history-runs",
      schemaVersion: 1,
      validate: (payload): payload is { runs: number[] } => Array.isArray((payload as { runs?: unknown }).runs),
    };
    await new DocumentStore(storeDir(repo)).commit((tx) => tx.write(history, { runs: [1, 2, 3] }));
    const before = await readFile(join(storeDir(repo), "history-runs.json"), "utf8");
    await rebuildCache(repo, { now: later });
    expect(await readFile(join(storeDir(repo), "history-runs.json"), "utf8")).toBe(before);
  });

  test("fails with exit 1 when the rebuilt analysis cannot be written", async () => {
    const repo = await copyFixture();
    await warm(repo);
    await writeFile(join(storeDir(repo), "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const before = await tree(storeDir(repo));
    const result = await cli("cache", "rebuild", "--repo", repo);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not be written");
    expect(result.stdout).toBe("");
    expect(await tree(storeDir(repo))).toEqual(before);
  });

  test("never contacts Jev and needs no credentials", async () => {
    const repo = await copyFixture();
    delete process.env.TYPESAFE_API_KEY;
    expect((await cli("cache", "rebuild", "--repo", repo)).code).toBe(0);
  });
});

describe("retention", () => {
  test("defaults", () => {
    expect(resolveRetention({})).toEqual({ bounds: DEFAULT_RETENTION, warnings: [] });
    expect(DEFAULT_RETENTION).toEqual({
      history: { maxRuns: 200, maxDays: 90 },
      decisions: { max: 500, maxDays: 7 },
      feedback: { max: 2000, maxDays: 365 },
    });
  });

  test("valid overrides, including zero and the cap", () => {
    const { bounds, warnings } = resolveRetention({
      SCOPE_HISTORY_MAX_RUNS: "50",
      SCOPE_HISTORY_MAX_DAYS: "0",
      SCOPE_DECISIONS_MAX: "5000",
      SCOPE_DECISIONS_MAX_DAYS: "70",
      SCOPE_FEEDBACK_MAX: "1",
      SCOPE_FEEDBACK_MAX_DAYS: "3650",
    });
    expect(warnings).toEqual([]);
    expect(bounds).toEqual({
      history: { maxRuns: 50, maxDays: 0 },
      decisions: { max: 5000, maxDays: 70 },
      feedback: { max: 1, maxDays: 3650 },
    });
  });

  test.each([["-1"], ["1e3"], [" 5"], ["5 "], ["+5"], ["1.5"], ["2001"], [""], ["abc"], ["99999999999999999999"]])(
    "invalid value %p warns and falls back to the default",
    (value) => {
      const { bounds, warnings } = resolveRetention({ SCOPE_HISTORY_MAX_RUNS: value, UNRELATED_SECRET: "hunter2" });
      expect(bounds).toEqual(DEFAULT_RETENTION);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("SCOPE_HISTORY_MAX_RUNS");
      expect(warnings[0]).toContain("0 to 2000");
      expect(warnings[0]).not.toContain("hunter2");
    },
  );

  test("status shows overrides", async () => {
    const repo = await copyFixture();
    const status = await cacheStatus(repo, { SCOPE_DECISIONS_MAX: "10" });
    expect(status.retention.bounds.decisions.max).toBe(10);
  });
});

describe("integrity key", () => {
  test("status does not create the key when it is absent", async () => {
    const saved = process.env.XDG_STATE_HOME;
    const state = await mkdtemp(join(tmpdir(), "scope-controls-state-"));
    process.env.XDG_STATE_HOME = state;
    try {
      const repo = await copyFixture();
      expect((await cli("cache", "status", "--repo", repo)).code).toBe(0);
      expect(await readdir(state)).toEqual([]);
    } finally {
      process.env.XDG_STATE_HOME = saved;
      await rm(state, { recursive: true, force: true });
    }
  });

  test("no command changes the key", async () => {
    const repo = await copyFixture();
    await warm(repo);
    const before = await keySnapshot();
    await utimes(integrityKeyPath()!, new Date(1_000_000), new Date(1_000_000));
    const stamped = await keySnapshot();
    for (const argv of [
      ["cache", "status", "--repo", repo],
      ["cache", "rebuild", "--repo", repo],
      ["cache", "clear", "--repo", repo, "--yes"],
    ]) {
      expect((await cli(...argv)).code).toBe(0);
      expect(await keySnapshot()).toEqual(stamped);
    }
    expect(stamped.bytes).toBe(before.bytes);
  });
});

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
});
