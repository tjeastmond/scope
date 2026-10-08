import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheStatus, clearCache, formatStatus, rebuildCache } from "../src/cache/controls.ts";
import {
  HISTORY_PREFIX,
  MAX_TASK_CHARS,
  buildHistoryRecord,
  historyMac,
  readHistory,
  type HistoryRecord,
} from "../src/cache/history.ts";
import { openRepositoryCache, type RepositoryCache } from "../src/cache/location.ts";
import { currentVersionKeys } from "../src/cache/versions.ts";
import { CancelledError } from "../src/errors.ts";
import { JEV_QUESTION_VERSION } from "../src/config.ts";
import { jevModel } from "../src/jev/provider.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/retrieval/config.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider, ScopeResult, SelectedChunk } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TASK = "Add retry handling to Stripe webhook processing";
const RELEVANCE = { processEvent: 0.9, withRetry: 0.8, computeBackoff: 0.7 };

let tmp: string;
const savedCache = process.env.SCOPE_CACHE;
const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-history-"));
  delete process.env.SCOPE_CACHE;
});
afterEach(async () => {
  if (savedCache === undefined) delete process.env.SCOPE_CACHE;
  else process.env.SCOPE_CACHE = savedCache;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  await rm(tmp, { recursive: true, force: true });
});

let copies = 0;
async function copyFixture(name = "webhook-service"): Promise<string> {
  const repo = join(tmp, `${name}-${copies++}`);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const historyNames = async (repo: string) =>
  (await readdir(storeDir(repo)).catch(() => [] as string[])).filter((name) => name.startsWith(HISTORY_PREFIX)).sort();
const historyPath = async (repo: string) => join(storeDir(repo), (await historyNames(repo))[0]!);

/** The clock is an hour ahead of the files, so no stat record is racy and a warm run commits nothing. */
const later = () => Date.now() + HOUR;

interface RunOptions {
  task?: string;
  provider?: DecisionProvider;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  noJev?: boolean;
  cache?: boolean;
  lockWaitMs?: number;
  signal?: AbortSignal;
}
const run = (repo: string, options: RunOptions = {}) =>
  runScope({
    task: options.task ?? TASK,
    repo,
    provider: options.provider ?? fakeProvider({ relevance: RELEVANCE, fallback: 0.05 }),
    noJev: options.noJev,
    cache: options.cache ?? true,
    signal: options.signal,
    explain: true,
    cacheOptions: { now: options.now ?? later, env: options.env ?? {}, lockWaitMs: options.lockWaitMs },
  });

async function open(repo: string): Promise<RepositoryCache> {
  const { cache } = await openRepositoryCache(repo);
  return cache!;
}
const history = async (repo: string) => (await readHistory(await open(repo))).records;

async function allText(directory: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? await allText(path) : `${path}\n${await readFile(path, "utf8")}\n`;
  }
  return text;
}

describe("what a Jev run records", () => {
  test("one verified record with the run's candidates, fingerprints, configuration and request metadata", async () => {
    const repo = await copyFixture();
    const { result } = await run(repo);
    expect(await historyNames(repo)).toHaveLength(1);
    const [record] = await history(repo);
    expect(record).toBeDefined();
    const { chunks } = await loadChunks(repo);
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");

    const expected: {
      chunkId: string;
      decision: string;
      relevance?: number;
      fingerprint: string;
      supportFor?: string[];
    }[] = [
      ...result.chunks.map((s) => ({
        chunkId: s.chunk.id,
        decision: s.supportFor ? "support" : "selected",
        relevance: s.relevance,
        fingerprint: sha(s.chunk.content),
        supportFor: s.supportFor,
      })),
      ...result.skipped.map((s) => ({
        chunkId: s.chunkId,
        decision: "skipped",
        relevance: s.relevance,
        fingerprint: sha(byId.get(s.chunkId)!.content),
        supportFor: undefined,
      })),
    ];
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(
      record!.candidates.map((c) => ({
        chunkId: c.chunkId,
        decision: c.decision,
        relevance: c.relevance,
        fingerprint: c.fingerprint,
        supportFor: c.supportFor,
      })),
    ).toEqual(expected as never);
    for (const candidate of record!.candidates) {
      const chunk = byId.get(candidate.chunkId)!;
      expect([candidate.file, candidate.kind, candidate.name]).toEqual([chunk.file, chunk.kind, chunk.name]);
    }
    expect(record!.candidates.some((c) => c.origin !== undefined)).toBe(true);

    const sdk = JSON.parse(
      await readFile(join(import.meta.dir, "../node_modules/@typesafe-ai/sdk/package.json"), "utf8"),
    );
    expect(record!.config).toEqual({
      scopeVersion: (await currentVersionKeys()).scope,
      sdkVersion: sdk.version,
      model: jevModel(),
      questionVersion: JEV_QUESTION_VERSION,
      retrievalConfigVersion: DEFAULT_RETRIEVAL_CONFIG.version,
    });
    expect(record!.request).toEqual({ latencyMs: 3, requestCount: 1, inputTokens: 5, outputTokens: 1 });
    expect(record!.mode).toBe("jev");
    expect(record!.task.text).toBe(TASK);
    expect(record!.task.truncated).toBe(false);
    expect(record!.task.terms.words.length).toBeGreaterThan(0);
    expect(record!.runId).toBe((await historyNames(repo))[0]!.slice(HISTORY_PREFIX.length, -".json".length));
  });

  test("no key, raw response, secret in the task or source text reaches .scope/", async () => {
    const repo = await copyFixture();
    process.env.TYPESAFE_API_KEY = "tsk-DISTINCTIVE-FAKE-KEY-0123456789";
    const base = fakeProvider({ relevance: RELEVANCE, fallback: 0.05 });
    const provider: DecisionProvider = {
      async decide(request) {
        const decision = await base.decide(request);
        return { ...decision, judgments: decision.judgments.map((j) => ({ ...j, raw: "RAW-JEV-ANSWER-9f3a" })) };
      },
    };
    const { result } = await run(repo, { provider, task: `${TASK} using AKIAIOSFODNN7EXAMPLE` });
    const stored = await allText(join(repo, ".scope"));
    expect(stored).toContain(HISTORY_PREFIX);
    expect(stored).not.toContain("tsk-DISTINCTIVE-FAKE-KEY-0123456789");
    expect(stored).not.toContain("RAW-JEV-ANSWER-9f3a");
    expect(stored).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const [record] = await history(repo);
    expect(record!.task.text).toContain("[REDACTED");
    // The history document holds no chunk source: the longest line of each selected chunk is absent from it.
    const text = await readFile(await historyPath(repo), "utf8");
    for (const { chunk } of result.chunks) {
      const line = chunk.content
        .split("\n")
        .map((l) => l.trim())
        .sort((a, b) => b.length - a.length)[0]!;
      expect(line.length).toBeGreaterThan(15);
      expect(text).not.toContain(line);
    }
  });

  test("a long task is stored cut to the limit and marked truncated", async () => {
    const repo = await copyFixture();
    await run(repo, { task: "retry handling ".repeat(400) });
    const [record] = await history(repo);
    expect(record!.task.text).toHaveLength(MAX_TASK_CHARS);
    expect(record!.task.truncated).toBe(true);
  });

  test("a chunk pulled in for coherence is recorded as a support, with the chunks it supports", async () => {
    const repo = await copyFixture("mixed-app");
    const { result } = await run(repo, { provider: fakeProvider({ relevance: {}, fallback: 0.9 }) });
    const supports = result.chunks.filter((s) => s.supportFor);
    expect(supports.length).toBeGreaterThan(0);
    const [record] = await history(repo);
    const recorded = record!.candidates.filter((c) => c.decision === "support");
    expect(recorded.map((c) => [c.chunkId, c.supportFor])).toEqual(supports.map((s) => [s.chunk.id, s.supportFor]));
  });
});

describe("support relevance", () => {
  test("a support Jev judged below the minimum keeps its relevance", async () => {
    const repo = await copyFixture();
    const { chunks } = await loadChunks(repo);
    const [needed, judged] = chunks;
    const selected = (chunk: CodeChunk, extra: Partial<SelectedChunk>): SelectedChunk => ({
      chunk,
      signals: {},
      score: 1,
      reason: "test",
      ...extra,
    });
    const result = {
      chunks: [selected(judged!, { relevance: 0.9 }), selected(needed!, { supportFor: [judged!.id] })],
      skipped: [],
    } as unknown as ScopeResult;
    const record = await buildHistoryRecord(
      { task: TASK, result, chunks: new Map(), relevance: new Map([[needed!.id, 0.02]]), time: 1 },
      { scope: "test" },
    );
    expect(record.candidates.map((c) => [c.decision, c.relevance])).toEqual([
      ["selected", 0.9],
      ["support", 0.02],
    ]);
  });
});

describe("what does not record", () => {
  test("--no-jev, no candidates, cache off and cancelled runs leave no history", async () => {
    const repo = await copyFixture();
    await run(repo, { noJev: true });
    expect(await historyNames(repo)).toEqual([]);

    const empty = join(tmp, "empty");
    await mkdir(empty);
    const { result } = await run(empty);
    expect(result.chunks).toEqual([]);
    expect(await historyNames(empty)).toEqual([]);

    const off = await copyFixture();
    await run(off, { cache: false });
    await expect(readdir(join(off, ".scope"))).rejects.toThrow();

    const cancelled = await copyFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(run(cancelled, { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(await historyNames(cancelled)).toEqual([]);

    const midway = await copyFixture();
    const during = new AbortController();
    const base = fakeProvider({ relevance: RELEVANCE });
    await run(midway, {
      signal: during.signal,
      provider: {
        async decide(request) {
          const decision = await base.decide(request);
          during.abort();
          return decision;
        },
      },
    });
    expect(await historyNames(midway)).toEqual([]);
  });
});

describe("retention", () => {
  const stamp = (repo: string) => historyNames(repo).then((names) => names.map((n) => Number(n.slice(8, 21))));

  test("keeps the newest SCOPE_HISTORY_MAX_RUNS runs", async () => {
    const repo = await copyFixture();
    const times = [1, 2, 3, 4, 5].map((i) => Date.now() + i * 1000);
    for (const time of times) await run(repo, { env: { SCOPE_HISTORY_MAX_RUNS: "3" }, now: () => time });
    expect(await stamp(repo)).toEqual(times.slice(2));
    expect((await history(repo)).map((r) => r.time)).toEqual(times.slice(2).reverse());
  });

  test("drops runs older than SCOPE_HISTORY_MAX_DAYS", async () => {
    const repo = await copyFixture();
    const start = Date.now();
    await run(repo, { now: () => start });
    await run(repo, { now: () => start + 20 * DAY });
    expect(await historyNames(repo)).toHaveLength(2);
    await run(repo, { env: { SCOPE_HISTORY_MAX_DAYS: "30" }, now: () => start + 40 * DAY });
    // The first run is 40 days old and gone; the second is 20 days old.
    expect(await stamp(repo)).toEqual([start + 20 * DAY, start + 40 * DAY]);
    await run(repo, { now: () => start + 200 * DAY });
    expect(await stamp(repo)).toEqual([start + 200 * DAY]);
  });

  test("SCOPE_HISTORY_MAX_RUNS=0 records nothing and removes existing history", async () => {
    const repo = await copyFixture();
    await run(repo);
    await run(repo);
    expect(await historyNames(repo)).toHaveLength(2);
    const { result } = await run(repo, { env: { SCOPE_HISTORY_MAX_RUNS: "0" } });
    expect(await historyNames(repo)).toEqual([]);
    expect(result.warnings.filter((w) => w.includes("history"))).toEqual([]);
  });

  test("SCOPE_HISTORY_MAX_DAYS=0 records nothing and removes existing history", async () => {
    const repo = await copyFixture();
    await run(repo);
    expect(await historyNames(repo)).toHaveLength(1);
    await run(repo, { env: { SCOPE_HISTORY_MAX_DAYS: "0" } });
    expect(await historyNames(repo)).toEqual([]);
  });

  test("an invalid bound warns in the run and the default applies", async () => {
    const repo = await copyFixture();
    const { result } = await run(repo, { env: { SCOPE_HISTORY_MAX_RUNS: "lots" } });
    expect(result.warnings.filter((w) => w.startsWith("SCOPE_HISTORY_MAX_RUNS must be"))).toHaveLength(1);
    expect(await historyNames(repo)).toHaveLength(1);
  });

  test("a history-* document Scope did not write is removed by the next run", async () => {
    const repo = await copyFixture();
    await run(repo);
    await writeFile(join(storeDir(repo), "history-foreign.json"), "{}");
    await run(repo);
    expect(await historyNames(repo)).toHaveLength(2);
    expect((await historyNames(repo)).every((name) => /^history-[0-9]{13}-[0-9a-f]{8}\.json$/.test(name))).toBe(true);
  });
});

describe("integrity", () => {
  test("a tampered record, a record signed by another key and a corrupt document are ignored", async () => {
    const repo = await copyFixture();
    await run(repo, { now: () => Date.now() + 1000 });
    await run(repo, { now: () => Date.now() + 2000 });
    await run(repo, { now: () => Date.now() + 3000 });
    const [tampered, planted, corrupt] = await historyNames(repo);
    expect((await history(repo)).length).toBe(3);

    const path = (name: string) => join(storeDir(repo), name);
    const edit = async (name: string, change: (doc: { record: HistoryRecord; mac: string }) => void) => {
      const doc = JSON.parse(await readFile(path(name), "utf8"));
      change(doc);
      await writeFile(path(name), JSON.stringify(doc));
    };
    await edit(tampered!, (doc) => (doc.record.task.text = "something else"));
    const cache = await open(repo);
    await edit(planted!, (doc) => (doc.mac = historyMac({ ...cache, integrityKey: randomBytes(32) }, doc.record)));
    await writeFile(path(corrupt!), "{ not json");

    const { records, warnings } = await readHistory(await open(repo));
    expect(records).toEqual([]);
    expect(warnings).toHaveLength(3);
    // A corrupt document does not fail a run.
    const { result } = await run(repo, { now: () => Date.now() + 4000 });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect((await history(repo)).length).toBe(1);
  });
  test("a signed record copied under another run's name is ignored", async () => {
    const repo = await copyFixture();
    await run(repo);
    const [name] = await historyNames(repo);
    const copy = `${HISTORY_PREFIX}0000000000001-00000000.json`;
    await writeFile(join(storeDir(repo), copy), await readFile(join(storeDir(repo), name!), "utf8"));
    const { records, warnings } = await readHistory(await open(repo));
    expect(records).toHaveLength(1);
    expect(warnings).toEqual([`${copy}: not signed by this user; ignoring it`]);
  });

  test("a record signed for another repository of the same user is ignored", async () => {
    const source = await copyFixture();
    const target = await copyFixture();
    await run(source);
    await run(target);
    const [name] = await historyNames(source);
    await writeFile(join(storeDir(target), name!), await readFile(join(storeDir(source), name!), "utf8"));
    const { records, warnings } = await readHistory(await open(target));
    expect(records).toHaveLength(1);
    expect(warnings).toEqual([`${name}: not signed by this user; ignoring it`]);
  });

  test("a history-* file with a name Scope never writes is skipped with a warning, not an error", async () => {
    const repo = await copyFixture();
    await run(repo);
    await writeFile(join(storeDir(repo), "history-BAD.json"), "{}");
    const { records, warnings } = await readHistory(await open(repo));
    expect(records).toHaveLength(1);
    expect(warnings).toEqual(["history-BAD.json: not a history document Scope wrote; ignoring it"]);
  });
});

describe("failure and neutrality", () => {
  test("a failed history commit only adds one warning", async () => {
    const repo = await copyFixture();
    await run(repo, { env: { SCOPE_HISTORY_MAX_RUNS: "0" } });
    const baseline = await run(repo, { env: { SCOPE_HISTORY_MAX_RUNS: "0" } });
    // A lock held right now, which a commit waits for and then gives up on.
    await writeFile(join(storeDir(repo), "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const failed = await run(repo, { lockWaitMs: 100 });
    const notes = failed.result.warnings.filter((w) => w.startsWith("history not recorded: "));
    expect(notes).toHaveLength(1);
    expect(failed.result.warnings.at(-1)).toBe(notes[0]!);
    expect({ ...failed.result, warnings: failed.result.warnings.filter((w) => w !== notes[0]) }).toEqual(
      baseline.result,
    );
    expect(await historyNames(repo)).toEqual([]);
  });

  test("recording history does not change the result", async () => {
    const withHistory = await run(await copyFixture());
    const without = await run(await copyFixture(), { env: { SCOPE_HISTORY_MAX_RUNS: "0" } });
    expect(JSON.stringify(withHistory.result)).toBe(JSON.stringify(without.result));
  });
});

describe("cache commands", () => {
  test("status counts history runs, rebuild keeps them and clear removes them", async () => {
    const repo = await copyFixture();
    await run(repo);
    await run(repo);
    const status = await cacheStatus(repo);
    expect(status.documents.historyRuns).toBe(2);
    expect(formatStatus(status)).toContain("history runs:  2");

    await rebuildCache(repo);
    expect(await historyNames(repo)).toHaveLength(2);
    expect((await cacheStatus(repo)).documents.historyRuns).toBe(2);

    await clearCache(repo);
    expect(await historyNames(repo)).toEqual([]);
    expect((await cacheStatus(repo)).documents.historyRuns).toBe(0);
  });
});
