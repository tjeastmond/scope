import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheStatus, clearCache, formatStatus, rebuildCache } from "../src/cache/controls.ts";
import { DECISION_PREFIX, type DecisionKeyOverrides, type DecisionRecord } from "../src/cache/decisions.ts";
import { HISTORY_PREFIX } from "../src/cache/history.ts";
import { recordMac } from "../src/cache/integrity.ts";
import { openRepositoryCache } from "../src/cache/location.ts";
import { currentVersionKeys } from "../src/cache/versions.ts";
import { JEV_CANDIDATE_MAX_CHARS } from "../src/config.ts";
import { defaultDecisionCacheKey, JevDecisionProvider } from "../src/jev/provider.ts";
import { UsageError } from "../src/errors.ts";
import { main, parseCli, type Io } from "../src/main.ts";
import { renderFormat } from "../src/output/index.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TASK = "Add retry handling to Stripe webhook processing";
const RELEVANCE = { processEvent: 0.9, withRetry: 0.8, computeBackoff: 0.7 };
const RAW = "RAW-ANSWER-DISTINCTIVE-4242";
const FAKE_KEY = "fake-typesafe-key-0123456789abcdef";

let tmp: string;
const savedCache = process.env.SCOPE_CACHE;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedModel = process.env.TYPESAFE_DEFAULT_MODEL;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-decisions-"));
  delete process.env.SCOPE_CACHE;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_DEFAULT_MODEL;
});
afterEach(async () => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("SCOPE_CACHE", savedCache);
  restore("TYPESAFE_API_KEY", savedKey);
  restore("TYPESAFE_DEFAULT_MODEL", savedModel);
  await rm(tmp, { recursive: true, force: true });
});

let copies = 0;
async function copyFixture(): Promise<string> {
  const repo = join(tmp, `webhook-service-${copies++}`);
  await cp(join(FIXTURES, "webhook-service"), repo, { recursive: true });
  return repo;
}

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const namesWith = async (repo: string, prefix: string) =>
  (await readdir(storeDir(repo)).catch(() => [] as string[])).filter((name) => name.startsWith(prefix)).sort();
const decisionNames = (repo: string) => namesWith(repo, DECISION_PREFIX);
const historyNames = (repo: string) => namesWith(repo, HISTORY_PREFIX);

/** The clock is an hour ahead of the files, so no stat record is racy. */
const later = () => Date.now() + HOUR;

/** A fake Jev that counts its calls and returns a distinctive raw answer (which must never be stored). */
function counting() {
  const inner = fakeProvider({ relevance: RELEVANCE, fallback: 0.05 });
  const provider: DecisionProvider & { calls: number } = {
    calls: 0,
    decisionCacheKey: inner.decisionCacheKey,
    async decide(request) {
      provider.calls++;
      const decision = await inner.decide(request);
      return { ...decision, judgments: decision.judgments.map((j) => ({ ...j, raw: RAW })) };
    },
  };
  return provider;
}

interface RunOptions {
  task?: string;
  provider?: DecisionProvider;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  noJev?: boolean;
  cache?: boolean;
  reuseDecisions?: boolean;
  lockWaitMs?: number;
  signal?: AbortSignal;
  keys?: Awaited<ReturnType<typeof currentVersionKeys>>;
  overrides?: DecisionKeyOverrides;
}
const run = (repo: string, options: RunOptions = {}) =>
  runScope({
    task: options.task ?? TASK,
    repo,
    provider: options.provider ?? fakeProvider({ relevance: RELEVANCE, fallback: 0.05 }),
    noJev: options.noJev,
    cache: options.cache ?? true,
    reuseDecisions: options.reuseDecisions,
    signal: options.signal,
    explain: true,
    cacheOptions: {
      now: options.now ?? later,
      env: options.env ?? {},
      lockWaitMs: options.lockWaitMs,
      keys: options.keys,
      decisionKeyOverrides: options.overrides,
    },
  });

describe("exact reuse", () => {
  test("an identical rerun makes no Jev call, selects the same context and discloses the reuse", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const time = Date.now() + HOUR;
    const first = await run(repo, { provider, now: () => time });
    expect(provider.calls).toBe(1);
    expect(first.result.decisionsReusedFrom).toBeUndefined();
    expect(first.result.jev).toBeDefined();

    const second = await run(repo, { provider, now: () => time + 1000 });
    expect(provider.calls).toBe(1);
    expect(second.decision).toBeUndefined();
    expect(second.result.chunks.length).toBeGreaterThan(0);
    expect(second.result.skipped.length).toBeGreaterThan(0);
    expect(second.result.chunks).toEqual(first.result.chunks);
    expect(second.result.regions).toEqual(first.result.regions);
    expect(second.result.skipped).toEqual(first.result.skipped);
    expect(second.result.decisionsReusedFrom).toBe(new Date(time).toISOString());
    expect(second.result.jev).toBeUndefined();
    // Nothing is invented for the reused decision, and the reason is still Jev's judgment.
    expect(second.result.chunks.every((c) => c.reason.startsWith("Jev relevance") || c.supportFor)).toBe(true);

    const disclosure = `Decisions reused from ${new Date(time).toISOString()}`;
    for (const format of ["text", "markdown"] as const) {
      expect(renderFormat(format, second.result)).toContain(disclosure);
      expect(renderFormat(format, first.result)).not.toContain("Decisions reused");
    }
    const json = JSON.parse(renderFormat("json", second.result));
    expect(json.decisionsReusedFrom).toBe(new Date(time).toISOString());
    expect(json.jev).toBeUndefined();
    expect(JSON.parse(renderFormat("json", first.result)).decisionsReusedFrom).toBeUndefined();

    // The original Jev run is in history once; the reuse adds no second record.
    expect(await historyNames(repo)).toHaveLength(1);
    expect(await decisionNames(repo)).toHaveLength(1);
  });

  test("a hit needs no provider and no credentials", async () => {
    const repo = await copyFixture();
    // Stands in for the real adapter: it shares the default adapter's identity, so the real path can reuse its decision.
    const inner = counting();
    const provider: DecisionProvider = {
      decide: (request) => inner.decide(request),
      decisionCacheKey: defaultDecisionCacheKey,
    };
    await run(repo, { provider });
    expect(inner.calls).toBe(1);
    delete process.env.TYPESAFE_API_KEY;
    // No provider is passed, so the real Jev adapter would be built (and fail without a key) on a miss.
    const { result } = await runScope({
      task: TASK,
      repo,
      cache: true,
      cacheOptions: { now: later, env: {} },
    });
    expect(result.decisionsReusedFrom).toBeDefined();
  });

  test("a provider without decisionCacheKey neither reads nor writes decisions", async () => {
    const repo = await copyFixture();
    const inner = counting();
    const provider: DecisionProvider & { calls: number } = {
      get calls() {
        return inner.calls;
      },
      decide: (request) => inner.decide(request),
    };
    await run(repo, { provider });
    await run(repo, { provider });
    expect(inner.calls).toBe(2);
    expect(await decisionNames(repo)).toHaveLength(0);
  });

  test("decisions of a different provider identity are not reused, in either direction", async () => {
    const repo = await copyFixture();
    const real = counting();
    const asDefault: DecisionProvider = { decide: (r) => real.decide(r), decisionCacheKey: defaultDecisionCacheKey };
    await run(repo, { provider: asDefault });
    const fake = counting();
    const { result } = await run(repo, { provider: fake });
    expect(fake.calls).toBe(1);
    expect(result.decisionsReusedFrom).toBeUndefined();
    // The fake's own decision is reused by the fake, and the default identity still finds its own.
    expect((await run(repo, { provider: fake })).result.decisionsReusedFrom).toBeDefined();
    expect((await run(repo, { provider: asDefault })).result.decisionsReusedFrom).toBeDefined();
    expect(fake.calls).toBe(1);
    expect(real.calls).toBe(1);
  });

  test("a Jev adapter's key follows its own limits, and the default one equals defaultDecisionCacheKey", async () => {
    const candidates: CodeChunk[] = [
      {
        id: "long-chunk",
        file: "src/long.ts",
        language: "typescript",
        kind: "function",
        name: "long",
        startLine: 1,
        endLine: 2,
        content: "x".repeat(JEV_CANDIDATE_MAX_CHARS + 500),
        references: [],
      },
    ];
    const client = { systemOne: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) };
    const standard = new JevDecisionProvider({ client });
    const short = new JevDecisionProvider({ client, candidateMaxChars: 100 });
    expect(standard.decisionCacheKey(TASK, candidates)).toEqual(defaultDecisionCacheKey(TASK, candidates));
    expect(short.decisionCacheKey(TASK, candidates)).not.toEqual(standard.decisionCacheKey(TASK, candidates));
  });
});

describe("misses", () => {
  async function missWith(
    variant: (repo: string) => Promise<RunOptions> | RunOptions,
    setup?: (repo: string) => Promise<void>,
    resets = false,
  ) {
    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider });
    expect(provider.calls).toBe(1);
    await setup?.(repo);
    const options = await variant(repo);
    const { result } = await run(repo, { provider, ...options });
    expect(provider.calls).toBe(2);
    expect(result.decisionsReusedFrom).toBeUndefined();
    // A new Scope version also resets the store, which drops the old document.
    expect(await decisionNames(repo)).toHaveLength(resets ? 1 : 2);
  }

  test("different task text, even by one character", () => missWith(() => ({ task: `${TASK}.` })));

  test("a candidate whose content changed", () =>
    missWith(
      () => ({}),
      async (repo) => {
        const path = join(repo, "src/util/retry.ts");
        const source = await readFile(path, "utf8");
        const changed = source.replace(
          "Math.random() * options.baseDelayMs",
          "Math.random() * options.baseDelayMs * 2",
        );
        expect(changed).not.toBe(source);
        await writeFile(path, changed);
      },
    ));

  test("a different candidate set", () =>
    missWith(
      () => ({}),
      async (repo) => {
        await writeFile(
          join(repo, "src/webhooks/retry-extra.ts"),
          "export function retryStripeWebhookProcessing(): number {\n  return 1;\n}\n",
        );
      },
    ));

  test("a change past the point where the request truncates a long candidate", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const path = join(repo, "src/webhooks/retry-long.ts");
    const body = (tail: string) =>
      `export function retryStripeWebhookProcessingLong(): string {\n  const pad = "${"x".repeat(JEV_CANDIDATE_MAX_CHARS + 500)}";\n  return pad + "${tail}";\n}\n`;
    await writeFile(path, body("aaaaa"));
    const first = await run(repo, { provider });
    const files = [...first.result.chunks, ...first.result.skipped].map((entry) =>
      "chunk" in entry ? entry.chunk.file : entry.file,
    );
    expect(files).toContain("src/webhooks/retry-long.ts");
    // Same length, so even the truncation marker is unchanged: only the content fingerprint tells them apart.
    await writeFile(path, body("bbbbb"));
    const second = await run(repo, { provider });
    expect(provider.calls).toBe(2);
    expect(second.result.decisionsReusedFrom).toBeUndefined();
  });

  test("a different question version", () => missWith(() => ({ overrides: { questionVersion: "other" } })));
  test("a different SDK version", () => missWith(() => ({ overrides: { sdkVersion: "0.0.0-other" } })));
  test("a different retrieval config version", () =>
    missWith(() => ({ overrides: { retrievalConfigVersion: "other" } })));
  test("a different model (override)", () => missWith(() => ({ overrides: { model: "other-model" } })));
  test("a different model (environment)", () =>
    missWith(
      () => ({}),
      async () => {
        process.env.TYPESAFE_DEFAULT_MODEL = "another-model";
      },
    ));
  test("a different Scope version", () =>
    missWith(async () => ({ keys: { ...(await currentVersionKeys()), scope: "0.0.0-other" } }), undefined, true));
});

describe("expiry", () => {
  test("a decision is reused up to SCOPE_DECISIONS_MAX_DAYS and not after", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const start = Date.now() + HOUR;
    await run(repo, { provider, now: () => start });
    const inside = await run(repo, { provider, now: () => start + 7 * DAY });
    expect(provider.calls).toBe(1);
    expect(inside.result.decisionsReusedFrom).toBe(new Date(start).toISOString());
    const outside = await run(repo, { provider, now: () => start + 7 * DAY + 1 });
    expect(provider.calls).toBe(2);
    expect(outside.result.decisionsReusedFrom).toBeUndefined();
    // The expired document was replaced by the fresh decision.
    expect(await decisionNames(repo)).toHaveLength(1);
  });

  test("the expiry follows SCOPE_DECISIONS_MAX_DAYS", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const start = Date.now() + HOUR;
    await run(repo, { provider, now: () => start });
    const env = { SCOPE_DECISIONS_MAX_DAYS: "2" };
    await run(repo, { provider, now: () => start + 2 * DAY, env });
    expect(provider.calls).toBe(1);
    await run(repo, { provider, now: () => start + 2 * DAY + 1, env });
    expect(provider.calls).toBe(2);
  });

  test("SCOPE_DECISIONS_MAX=0 never reuses and removes stored decisions", async () => {
    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider });
    expect(await decisionNames(repo)).toHaveLength(1);
    const env = { SCOPE_DECISIONS_MAX: "0" };
    const off = await run(repo, { provider, env });
    expect(provider.calls).toBe(2);
    expect(off.result.decisionsReusedFrom).toBeUndefined();
    expect(await decisionNames(repo)).toEqual([]);
    await run(repo, { provider, env });
    expect(provider.calls).toBe(3);
    expect(await decisionNames(repo)).toEqual([]);
  });

  test("a stored decision with a time in the future is not reused", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const start = Date.now() + HOUR;
    await run(repo, { provider, now: () => start });
    await run(repo, { provider, now: () => start - 1000 });
    expect(provider.calls).toBe(2);
  });
});

describe("--fresh", () => {
  test("asks Jev even with a stored match, then the next default run reuses the newer decision", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const start = Date.now() + HOUR;
    await run(repo, { provider, now: () => start });
    const fresh = await run(repo, { provider, now: () => start + 1000, reuseDecisions: false });
    expect(provider.calls).toBe(2);
    expect(fresh.result.decisionsReusedFrom).toBeUndefined();
    // One document per key: the older one was replaced.
    const names = await decisionNames(repo);
    expect(names).toHaveLength(1);
    expect(Number(names[0]!.slice(DECISION_PREFIX.length, DECISION_PREFIX.length + 13))).toBe(start + 1000);
    // A --fresh run records history as usual.
    expect(await historyNames(repo)).toHaveLength(2);
    const next = await run(repo, { provider, now: () => start + 2000 });
    expect(provider.calls).toBe(2);
    expect(next.result.decisionsReusedFrom).toBe(new Date(start + 1000).toISOString());
  });

  test("the CLI accepts --fresh on a task and rejects it for cache subcommands", () => {
    const options = parseCli([TASK, "--fresh"]);
    expect(options.kind === "run" && options.fresh).toBe(true);
    const plain = parseCli([TASK]);
    expect(plain.kind === "run" && plain.fresh).toBe(false);
    expect(() => parseCli(["cache", "status", "--fresh"])).toThrow(UsageError);
  });

  test("scope reuses by default and --fresh asks again, end to end", async () => {
    const repo = await copyFixture();
    const provider = counting();
    const invoke = async (args: string[], io: Partial<Io> = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main([TASK, "--repo", repo, ...args], {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        provider,
        ...io,
      });
      return { code, stdout: out.join(""), stderr: err.join("") };
    };
    expect((await invoke([])).code).toBe(0);
    expect(provider.calls).toBe(1);
    const reused = await invoke([]);
    expect(provider.calls).toBe(1);
    expect(reused.stdout).toContain("Decisions reused from ");
    expect(reused.stdout).toContain("run with --fresh to ask Jev again");
    expect(reused.stderr).not.toContain("Jev ");
    const fresh = await invoke(["--fresh"]);
    expect(provider.calls).toBe(2);
    expect(fresh.stdout).not.toContain("Decisions reused");
  });
});

describe("what neither reads nor writes decisions", () => {
  test("cache off, --no-jev, no candidates and a cancelled run", async () => {
    const off = await copyFixture();
    await run(off, { cache: false });
    await expect(readdir(join(off, ".scope"))).rejects.toThrow();

    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider, noJev: true });
    expect(provider.calls).toBe(0);
    expect(await decisionNames(repo)).toEqual([]);

    // A stored decision is not read by --no-jev, and cache:false does not reuse it.
    await run(repo, { provider });
    expect(provider.calls).toBe(1);
    const baseline = await run(repo, { provider, noJev: true });
    expect(baseline.result.decisionsReusedFrom).toBeUndefined();
    const uncached = await run(repo, { provider, cache: false });
    expect(provider.calls).toBe(2);
    expect(uncached.result.decisionsReusedFrom).toBeUndefined();

    const empty = join(tmp, "empty");
    await mkdir(empty);
    const none = await run(empty, { provider });
    expect(none.result.chunks).toEqual([]);
    expect(provider.calls).toBe(2);
    expect(await decisionNames(empty)).toEqual([]);

    const midway = await copyFixture();
    const during = new AbortController();
    const base = counting();
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
    expect(await decisionNames(midway)).toEqual([]);
  });
});

describe("integrity", () => {
  async function tampered(
    change: (repo: string, name: string, doc: { record: DecisionRecord; mac: string }) => Promise<void>,
  ) {
    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider });
    const [name] = await decisionNames(repo);
    const doc = JSON.parse(await readFile(join(storeDir(repo), name!), "utf8"));
    await change(repo, name!, doc);
    const { result } = await run(repo, { provider });
    expect(provider.calls).toBe(2);
    expect(result.decisionsReusedFrom).toBeUndefined();
    expect(result.chunks.length).toBeGreaterThan(0);
    return repo;
  }
  const write = (repo: string, name: string, doc: unknown) =>
    writeFile(join(storeDir(repo), name), typeof doc === "string" ? doc : JSON.stringify(doc));

  test("a document with an edited relevance and the old MAC is a miss", () =>
    tampered(async (repo, name, doc) => {
      doc.record.judgments[0]!.relevance = 0.99;
      await write(repo, name, doc);
    }));

  test("a document copied to another key's name is a miss", async () => {
    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider });
    await run(repo, { provider, task: `${TASK} again` });
    const [first, second] = await decisionNames(repo);
    // The second task's document now holds the first task's (validly signed) record.
    await write(repo, second!, await readFile(join(storeDir(repo), first!), "utf8"));
    const { result } = await run(repo, { provider, task: `${TASK} again` });
    expect(provider.calls).toBe(3);
    expect(result.decisionsReusedFrom).toBeUndefined();
  });

  test("a document signed under another key is a miss", () =>
    tampered(async (repo, name, doc) => {
      const { cache } = await openRepositoryCache(repo);
      doc.mac = recordMac(randomBytes(32), "decision", { root: cache!.root, record: doc.record });
      await write(repo, name, doc);
    }));

  test("a document signed for another repository root is a miss", () =>
    tampered(async (repo, name, doc) => {
      const { cache } = await openRepositoryCache(repo);
      const other = await realpath(await copyFixture());
      expect(other).not.toBe(cache!.root);
      doc.mac = recordMac(cache!.integrityKey, "decision", { root: other, record: doc.record });
      await write(repo, name, doc);
    }));

  test("a corrupt document is a miss", () => tampered((repo, name) => write(repo, name, "{ not json")));

  test("judgments that do not cover the current candidates are a miss, even when correctly signed", () =>
    tampered(async (repo, name, doc) => {
      const { cache } = await openRepositoryCache(repo);
      doc.record.judgments = doc.record.judgments.slice(1);
      doc.mac = recordMac(cache!.integrityKey, "decision", { root: cache!.root, record: doc.record });
      await write(repo, name, doc);
    }));

  test("a document with an out-of-range relevance is a miss, even when correctly signed", () =>
    tampered(async (repo, name, doc) => {
      const { cache } = await openRepositoryCache(repo);
      doc.record.judgments[0]!.relevance = 7;
      doc.mac = recordMac(cache!.integrityKey, "decision", { root: cache!.root, record: doc.record });
      await write(repo, name, doc);
    }));
});

describe("retention", () => {
  test("SCOPE_DECISIONS_MAX keeps the newest decisions", async () => {
    const repo = await copyFixture();
    const env = { SCOPE_DECISIONS_MAX: "2" };
    const start = Date.now() + HOUR;
    const times = [1, 2, 3].map((i) => start + i * 1000);
    for (const [index, time] of times.entries()) {
      await run(repo, { env, now: () => time, task: `${TASK} variant ${index}` });
    }
    const stamps = (await decisionNames(repo)).map((name) =>
      Number(name.slice(DECISION_PREFIX.length, DECISION_PREFIX.length + 13)),
    );
    expect(stamps).toEqual(times.slice(1));
  });

  test("a planted far-future name never takes a slot", async () => {
    const repo = await copyFixture();
    const env = { SCOPE_DECISIONS_MAX: "2" };
    const start = Date.now() + HOUR;
    await run(repo, { env, now: () => start });
    const [real] = await decisionNames(repo);
    await writeFile(join(storeDir(repo), `${DECISION_PREFIX}9999999999999-${"0".repeat(64)}.json`), "{}");
    await writeFile(join(storeDir(repo), `${DECISION_PREFIX}foreign.json`), "{}");
    await run(repo, { env, now: () => start + 1000, task: `${TASK} other` });
    const names = await decisionNames(repo);
    expect(names).toHaveLength(2);
    expect(names).toContain(real!);
    expect(names.some((name) => name.includes("9999999999999"))).toBe(false);
  });

  test("a write removes expired decisions of other tasks", async () => {
    const repo = await copyFixture();
    const start = Date.now() + HOUR;
    await run(repo, { now: () => start });
    const [old] = await decisionNames(repo);
    await run(repo, { now: () => start + 7 * DAY + 1, task: `${TASK} other` });
    const names = await decisionNames(repo);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(old!);
  });
});

describe("what is stored", () => {
  test("no task text, source code, key or raw Jev answer", async () => {
    process.env.TYPESAFE_API_KEY = FAKE_KEY;
    const repo = await copyFixture();
    await run(repo, { provider: counting() });
    const names = await decisionNames(repo);
    expect(names).toHaveLength(1);
    const text = await readFile(join(storeDir(repo), names[0]!), "utf8");
    expect(text).toContain("judgments");
    for (const secret of [TASK, "Stripe webhook", "jitter", "Math.random", FAKE_KEY, RAW, "raw"]) {
      expect(text).not.toContain(secret);
    }
    // Neither the name nor anything else in the decision documents carries the task.
    expect(names[0]).toMatch(/^decision-[0-9]{13}-[0-9a-f]{64}\.json$/);
  });
});

describe("failure", () => {
  test("a failed decision commit adds one warning and changes nothing else", async () => {
    const repo = await copyFixture();
    const provider = counting();
    // Warm the analysis cache so only the decision (and history) commits are left to fail.
    await run(repo, { provider, env: { SCOPE_DECISIONS_MAX: "0" } });
    const baseline = await run(repo, { provider, cache: false });
    await writeFile(join(storeDir(repo), "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const failed = await run(repo, { provider, lockWaitMs: 100 });
    const notes = failed.result.warnings.filter((w) => w.startsWith("decision not cached: "));
    expect(notes).toHaveLength(1);
    expect(failed.result.warnings.at(-1)).toBe(notes[0]!);
    const others = failed.result.warnings.filter((w) => w !== notes[0] && !w.startsWith("history not recorded: "));
    expect({ ...failed.result, warnings: others }).toEqual(baseline.result);
    expect(await decisionNames(repo)).toEqual([]);
  });
});

describe("cache commands", () => {
  test("status counts decisions, rebuild keeps them and clear removes them", async () => {
    const repo = await copyFixture();
    const provider = counting();
    await run(repo, { provider });
    await run(repo, { provider, task: `${TASK} second` });
    const status = await cacheStatus(repo);
    expect(status.documents.decisions).toBe(2);
    expect(formatStatus(status)).toContain("decisions:     2");

    await rebuildCache(repo);
    expect(await decisionNames(repo)).toHaveLength(2);
    expect((await cacheStatus(repo)).documents.decisions).toBe(2);
    const reused = await run(repo, { provider });
    expect(provider.calls).toBe(2);
    expect(reused.result.decisionsReusedFrom).toBeDefined();

    await clearCache(repo);
    expect(await decisionNames(repo)).toEqual([]);
    expect((await cacheStatus(repo)).documents.decisions).toBe(0);
  });
});
