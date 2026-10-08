import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEvidence, isConfirmedIrrelevant, isConfirmedUseful, loadEvidence } from "../src/cache/evidence.ts";
import {
  FEEDBACK_PREFIX,
  feedbackMac,
  readFeedback,
  recordFeedback,
  type FeedbackChunkRef,
  type FeedbackMissing,
  type FeedbackRecord,
  type FeedbackSource,
} from "../src/cache/feedback.ts";
import { contentFingerprint, type HistoryCandidate, type HistoryRecord } from "../src/cache/history.ts";
import { openRepositoryCache } from "../src/cache/location.ts";
import { submitFeedback } from "../src/feedback.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;
const TASK = "Add retry handling to Stripe webhook processing";
const FAKE_KEY = "fake-typesafe-key-0123456789abcdef";
const SOURCE_LITERAL = "lastError";
const A = "src/a.ts:function:a:1-3";
const B = "src/b.ts:function:b:1-3";
const FP_A = contentFingerprint("function a() {}");
const FP_A2 = contentFingerprint("function a() { return 2; }");
const FP_B = contentFingerprint("function b() {}");

const pad = (n: number) => String(n).padStart(13, "0");
const id = (n: number) => `${pad(n)}-${(n % 2 ** 32).toString(16).padStart(8, "0")}`;

function candidate(chunkId: string, fingerprint: string, extra: Partial<HistoryCandidate> = {}): HistoryCandidate {
  return {
    chunkId,
    file: chunkId.split(":")[0]!,
    kind: "function",
    fingerprint,
    decision: "selected",
    ...extra,
  };
}

function historyRecord(n: number, candidates: HistoryCandidate[]): HistoryRecord {
  return {
    recordVersion: 1,
    runId: id(n),
    time: n,
    task: { text: "t", truncated: false, terms: { exact: [], words: [], variants: [] } },
    mode: "jev",
    config: { scopeVersion: "0", sdkVersion: "0", model: "m", questionVersion: "1", retrievalConfigVersion: "1" },
    request: {},
    candidates,
  };
}

const ref = (chunkId: string, fingerprint: string, current = true): FeedbackChunkRef => ({
  chunkId,
  fingerprint,
  current,
});

function feedbackRecord(
  n: number,
  parts: { useful?: FeedbackChunkRef[]; irrelevant?: FeedbackChunkRef[]; missing?: FeedbackMissing[] },
  source: FeedbackSource = { kind: "user" },
): FeedbackRecord {
  return {
    recordVersion: 3,
    feedbackId: id(n),
    runId: id(1),
    time: n,
    source,
    useful: parts.useful ?? [],
    irrelevant: parts.irrelevant ?? [],
    missing: parts.missing ?? [],
  };
}

const now = new Map([
  [A, FP_A],
  [B, FP_B],
]);

describe("collectEvidence", () => {
  test("repeated selection with a high Jev score and no feedback is not confirmation", () => {
    const history = Array.from({ length: 100 }, (_, i) =>
      historyRecord(i + 1, [candidate(A, FP_A, { relevance: 0.95 })]),
    );
    const { chunks, stale } = collectEvidence(history, [], now);
    const evidence = chunks.get(A)!;
    expect(evidence.predictions).toEqual({ selected: 100, support: 0, skipped: 0 });
    expect(evidence.jev.judged).toBe(100);
    expect(evidence.jev.meanRelevance).toBeCloseTo(0.95, 10);
    expect(evidence.jev.maxRelevance).toBe(0.95);
    expect(evidence.feedback).toEqual({ useful: 0, irrelevant: 0, missing: 0, sources: 0 });
    expect(isConfirmedUseful(evidence.feedback)).toBe(false);
    expect(isConfirmedIrrelevant(evidence.feedback)).toBe(false);
    expect(stale.observations).toBe(0);
  });

  test("counts selected, support and skipped separately, and Jev judgments only where there is a relevance", () => {
    const history = [
      historyRecord(1, [candidate(A, FP_A, { relevance: 0.5 })]),
      historyRecord(2, [candidate(A, FP_A, { decision: "support", supportFor: [B] })]),
      historyRecord(3, [candidate(A, FP_A, { decision: "skipped", relevance: 0.1 })]),
    ];
    const evidence = collectEvidence(history, [], now).chunks.get(A)!;
    expect(evidence.predictions).toEqual({ selected: 1, support: 1, skipped: 1 });
    expect(evidence.jev.judged).toBe(2);
    expect(evidence.jev.meanRelevance).toBeCloseTo(0.3, 10);
    expect(evidence.jev.maxRelevance).toBe(0.5);
  });

  test("one useful report confirms; more irrelevant than useful confirms irrelevant; a tie is neither", () => {
    const useful = collectEvidence([], [feedbackRecord(1, { useful: [ref(A, FP_A)] })], now).chunks.get(A)!;
    expect(isConfirmedUseful(useful.feedback)).toBe(true);
    expect(isConfirmedIrrelevant(useful.feedback)).toBe(false);

    const irrelevant = collectEvidence(
      [],
      [
        feedbackRecord(1, { useful: [ref(A, FP_A)] }),
        feedbackRecord(2, { irrelevant: [ref(A, FP_A)] }),
        feedbackRecord(3, { irrelevant: [ref(A, FP_A)] }),
      ],
      now,
    ).chunks.get(A)!;
    expect(irrelevant.feedback).toMatchObject({ useful: 1, irrelevant: 2 });
    expect(isConfirmedIrrelevant(irrelevant.feedback)).toBe(true);
    expect(isConfirmedUseful(irrelevant.feedback)).toBe(false);

    const tie = collectEvidence(
      [],
      [feedbackRecord(1, { useful: [ref(A, FP_A)] }), feedbackRecord(2, { irrelevant: [ref(A, FP_A)] })],
      now,
    ).chunks.get(A)!;
    expect(isConfirmedUseful(tie.feedback)).toBe(false);
    expect(isConfirmedIrrelevant(tie.feedback)).toBe(false);
  });

  test("a symbol --missing counts once per listed chunk and counts toward confirmation", () => {
    const missing: FeedbackMissing = {
      symbol: "a",
      chunks: [
        { chunkId: A, fingerprint: FP_A },
        { chunkId: B, fingerprint: FP_B },
      ],
    };
    const { chunks } = collectEvidence([], [feedbackRecord(1, { missing: [missing] })], now);
    expect(chunks.get(A)!.feedback).toMatchObject({ missing: 1, useful: 0 });
    expect(chunks.get(B)!.feedback.missing).toBe(1);
    expect(isConfirmedUseful(chunks.get(A)!.feedback)).toBe(true);
    // Missing outweighs one irrelevant report, but not two.
    const mixed = collectEvidence(
      [],
      [
        feedbackRecord(1, { missing: [missing] }),
        feedbackRecord(2, { irrelevant: [ref(A, FP_A)] }),
        feedbackRecord(3, { irrelevant: [ref(A, FP_A)] }),
      ],
      now,
    ).chunks.get(A)!;
    expect(isConfirmedIrrelevant(mixed.feedback)).toBe(true);
  });

  test("a changed chunk contributes nothing and is counted as stale, in all three classes", () => {
    const history = [historyRecord(1, [candidate(A, FP_A, { relevance: 0.9 }), candidate(B, FP_B)])];
    const feedback = [
      feedbackRecord(2, {
        useful: [ref(A, FP_A)],
        missing: [{ symbol: "a", chunks: [{ chunkId: A, fingerprint: FP_A }] }],
      }),
    ];
    const edited = new Map([
      [A, FP_A2],
      [B, FP_B],
    ]);
    const { chunks, stale } = collectEvidence(history, feedback, edited);
    expect(chunks.has(A)).toBe(false);
    expect(chunks.get(B)!.predictions.selected).toBe(1);
    // One history candidate, one useful ref, one symbol chunk.
    expect(stale.observations).toBe(3);
  });

  test("a deleted chunk contributes nothing and is counted as stale", () => {
    const history = [historyRecord(1, [candidate(A, FP_A, { relevance: 0.9 })])];
    const feedback = [feedbackRecord(2, { irrelevant: [ref(A, FP_A)] })];
    const { chunks, stale } = collectEvidence(history, feedback, new Map([[B, FP_B]]));
    expect(chunks.size).toBe(0);
    expect(stale.observations).toBe(2);
  });

  test("feedback given about already-changed code (current false) never counts", () => {
    const feedback = [feedbackRecord(1, { useful: [ref(A, FP_A, false)] })];
    const { chunks, stale } = collectEvidence([], feedback, now);
    expect(chunks.has(A)).toBe(false);
    expect(stale.observations).toBe(1);
  });

  test("distinct sources: two agents and the user make 3; the same agent twice makes 1", () => {
    const three = collectEvidence(
      [],
      [
        feedbackRecord(1, { useful: [ref(A, FP_A)] }),
        feedbackRecord(2, { useful: [ref(A, FP_A)] }, { kind: "agent", name: "alpha" }),
        feedbackRecord(3, { useful: [ref(A, FP_A)] }, { kind: "agent", name: "beta" }),
      ],
      now,
    ).chunks.get(A)!;
    expect(three.feedback.sources).toBe(3);
    expect(three.feedback.lastTime).toBe(3);
    const one = collectEvidence(
      [],
      [
        feedbackRecord(1, { useful: [ref(A, FP_A)] }, { kind: "agent", name: "alpha" }),
        feedbackRecord(2, { irrelevant: [ref(A, FP_A)] }, { kind: "agent", name: "alpha" }),
      ],
      now,
    ).chunks.get(A)!;
    expect(one.feedback.sources).toBe(1);
    // An agent literally named "user" is not the user.
    const named = collectEvidence(
      [],
      [
        feedbackRecord(1, { useful: [ref(A, FP_A)] }),
        feedbackRecord(2, { useful: [ref(A, FP_A)] }, { kind: "agent", name: "user" }),
      ],
      now,
    ).chunks.get(A)!;
    expect(named.feedback.sources).toBe(2);
  });

  test("path-level missing entries are kept for included files and dropped, as stale, for others", () => {
    const feedback = [
      feedbackRecord(1, {
        missing: [
          { path: "src/a.ts", startLine: 1, endLine: 3, chunks: [] },
          { path: "src/gone.ts", chunks: [] },
        ],
      }),
      feedbackRecord(2, {
        missing: [
          { path: "src/a.ts", startLine: 1, endLine: 3, chunks: [] },
          { path: "src/a.ts", chunks: [] },
        ],
      }),
    ];
    const { missingLocations, stale } = collectEvidence([], feedback, now, new Set(["src/a.ts"]));
    expect(missingLocations).toEqual([
      { path: "src/a.ts", count: 1 },
      { path: "src/a.ts", startLine: 1, endLine: 3, count: 2 },
    ]);
    expect(stale.observations).toBe(1);
    expect(collectEvidence([], feedback, now).missingLocations).toEqual([]);
  });

  test("a path-level missing entry counts for each chunk it listed while that chunk's content is unchanged", () => {
    const feedback = [
      feedbackRecord(1, {
        missing: [{ path: "src/a.ts", chunks: [{ chunkId: A, fingerprint: FP_A }] }],
      }),
      feedbackRecord(2, {
        missing: [
          { path: "src/b.ts", startLine: 1, endLine: 3, chunks: [{ chunkId: B, fingerprint: "e".repeat(64) }] },
        ],
      }),
    ];
    const { chunks } = collectEvidence([], feedback, now, new Set(["src/a.ts", "src/b.ts"]));
    expect(chunks.get(A)!.feedback.missing).toBe(1);
    expect(chunks.get(B)).toBeUndefined();
  });

  test("the result does not depend on the order of the inputs", () => {
    const history = [
      historyRecord(1, [candidate(A, FP_A, { relevance: 0.1 }), candidate(B, FP_B, { relevance: 0.7 })]),
      historyRecord(2, [candidate(A, FP_A, { relevance: 0.2 }), candidate(B, FP_B, { decision: "skipped" })]),
      historyRecord(3, [candidate(A, FP_A, { relevance: 0.3 })]),
    ];
    const feedback = [
      feedbackRecord(
        4,
        { useful: [ref(A, FP_A)], missing: [{ path: "src/a.ts", chunks: [] }] },
        { kind: "agent", name: "x" },
      ),
      feedbackRecord(5, { irrelevant: [ref(B, FP_B)] }),
      feedbackRecord(6, { missing: [{ symbol: "b", chunks: [{ chunkId: B, fingerprint: FP_B }] }] }),
    ];
    const files = new Set(["src/a.ts"]);
    const forward = collectEvidence(history, feedback, now, files);
    const backward = collectEvidence(
      [...history].reverse(),
      [...feedback].reverse(),
      new Map([...now].reverse()),
      files,
    );
    expect(JSON.stringify([...backward.chunks])).toBe(JSON.stringify([...forward.chunks]));
    expect(backward.missingLocations).toEqual(forward.missingLocations);
    expect(backward.stale).toEqual(forward.stale);
    expect([...forward.chunks.keys()]).toEqual([A, B]);
  });
});

describe("record version 2 and the stored data", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_NAMES = ["SCOPE_CACHE", "SCOPE_FEEDBACK_MAX", "SCOPE_FEEDBACK_MAX_DAYS", "TYPESAFE_API_KEY"];
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "scope-evidence-"));
    for (const name of ENV_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(async () => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(tmp, { recursive: true, force: true });
  });

  const later = () => Date.now() + HOUR;
  const storeDir = (repo: string) => join(repo, ".scope/store-v1");
  const feedbackNames = async (repo: string) =>
    (await readdir(storeDir(repo)).catch(() => [] as string[])).filter((name) => name.startsWith(FEEDBACK_PREFIX));

  async function started() {
    const repo = join(tmp, "repo");
    await cp(join(FIXTURES, "webhook-service"), repo, { recursive: true });
    const { result } = await runScope({
      task: TASK,
      repo,
      provider: fakeProvider({ relevance: { processEvent: 0.9, withRetry: 0.8, computeBackoff: 0.7 }, fallback: 0.05 }),
      cache: true,
      cacheOptions: { now: later, env: {} },
    });
    return { repo, result, runId: result.runId!, a: result.chunks[0]!.chunk.id, skipped: result.skipped[0]!.chunkId };
  }
  const give = (
    repo: string,
    input: { runId: string; useful?: string[]; irrelevant?: string[]; missing?: string[] },
    at = later,
  ) =>
    submitFeedback({ useful: [], irrelevant: [], missing: [], ...input }, { repo, env: {}, cacheOptions: { now: at } });

  test("stored feedback carries fingerprints that match the history and the current source, end to end", async () => {
    const { repo, runId, a, skipped } = await started();
    await give(repo, { runId, useful: [a], irrelevant: [skipped], missing: ["processEvent"] });
    const cache = (await openRepositoryCache(repo)).cache!;
    const { chunks, files } = await loadChunks(repo);
    const { summary, warnings } = await loadEvidence(cache, chunks, files);
    expect(warnings).toEqual([]);
    expect(summary.stale.observations).toBe(0);
    const fingerprintOf = (chunkId: string) => contentFingerprint(chunks.find((c) => c.id === chunkId)!.content);
    expect(summary.chunks.get(a)!.fingerprint).toBe(fingerprintOf(a));
    expect(summary.chunks.get(a)!.feedback.useful).toBe(1);
    expect(summary.chunks.get(a)!.predictions.selected).toBe(1);
    expect(summary.chunks.get(skipped)!.feedback.irrelevant).toBe(1);
    expect(isConfirmedUseful(summary.chunks.get(a)!.feedback)).toBe(true);
    expect(isConfirmedIrrelevant(summary.chunks.get(skipped)!.feedback)).toBe(true);
    const named = chunks.filter((chunk) => chunk.name === "processEvent");
    for (const chunk of named) expect(summary.chunks.get(chunk.id)!.feedback.missing).toBe(1);
    // Editing the chunk's file after the feedback drops its evidence.
    const target = chunks.find((c) => c.id === a)!;
    const path = join(repo, target.file);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[target.startLine - 1] = `${lines[target.startLine - 1]} // edited`;
    await writeFile(path, lines.join("\n"));
    const after = await loadChunks(repo);
    const reloaded = await loadEvidence(cache, after.chunks, after.files);
    expect(reloaded.summary.chunks.has(a)).toBe(false);
    expect(reloaded.summary.stale.observations).toBeGreaterThan(0);
  });

  test("a version 1 document is skipped by readFeedback and pruned at the next write", async () => {
    const { repo, runId, a } = await started();
    await give(repo, { runId, useful: [a] });
    const [name] = await feedbackNames(repo);
    const path = join(storeDir(repo), name!);
    const document = JSON.parse(await readFile(path, "utf8"));
    const cache = (await openRepositoryCache(repo)).cache!;
    const record = document.record;
    // A version 1 record: no fingerprints. Re-signed so only the shape check can reject it.
    const v1 = { ...record, recordVersion: 1, useful: [{ chunkId: a, current: true }] };
    await writeFile(path, JSON.stringify({ ...document, record: v1, mac: feedbackMac(cache, v1) }));
    const read = await readFeedback(cache);
    expect(read.records).toEqual([]);
    expect(read.warnings.length).toBe(1);
    await give(repo, { runId, useful: [a] }, () => Date.now() + 2 * HOUR);
    const names = await feedbackNames(repo);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(name!);
    expect((await readFeedback(cache)).records).toHaveLength(1);
  });

  test("the strict check requires fingerprints: a record without or with a malformed one is skipped", async () => {
    const { repo, runId, a } = await started();
    const cache = (await openRepositoryCache(repo)).cache!;
    const base = feedbackRecord(Date.now() + HOUR, { useful: [ref(a, FP_A)] });
    const bad = (record: unknown) => ({ ...base, ...(record as object) }) as FeedbackRecord;
    const variants = [
      bad({ useful: [{ chunkId: a, current: true }] }),
      bad({ useful: [{ chunkId: a, fingerprint: "ABC", current: true }] }),
      bad({ missing: [{ symbol: "s", chunks: [{ chunkId: a }] }] }),
      bad({ missing: [{ symbol: "s", chunkIds: [a] }] }),
    ];
    let n = 0;
    for (const variant of variants) {
      const record = { ...variant, runId, feedbackId: id(Date.now() + HOUR + n++) };
      await recordFeedback(cache, record, { env: {}, now: record.time });
      expect((await readFeedback(cache)).records).toEqual([]);
    }
    const good = { ...base, runId, feedbackId: id(Date.now() + HOUR + 100) };
    await recordFeedback(cache, good, { env: {}, now: good.time });
    expect((await readFeedback(cache)).records).toHaveLength(1);
  });

  test("no task text, source literal or API key reaches a feedback document", async () => {
    const { repo, runId, a, result } = await started();
    process.env.TYPESAFE_API_KEY = FAKE_KEY;
    const source = await readFile(join(repo, "src/util/retry.ts"), "utf8");
    expect(source).toContain(SOURCE_LITERAL);
    await give(repo, { runId, useful: [a], irrelevant: [result.skipped[0]!.chunkId], missing: ["processEvent"] });
    for (const name of await feedbackNames(repo)) {
      const text = await readFile(join(storeDir(repo), name), "utf8");
      expect(text).not.toContain(TASK);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(SOURCE_LITERAL);
      for (const selected of result.chunks) expect(text).not.toContain(selected.chunk.content.slice(0, 80));
    }
  });
});
