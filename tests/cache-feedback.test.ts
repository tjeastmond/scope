import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DECISION_PREFIX } from "../src/cache/decisions.ts";
import {
  FEEDBACK_PREFIX,
  feedbackMac,
  readFeedback,
  recordFeedback,
  type FeedbackRecord,
} from "../src/cache/feedback.ts";
import { readHistory } from "../src/cache/history.ts";
import { openRepositoryCache, type RepositoryCache } from "../src/cache/location.ts";
import { readBoundedFile, readBoundedText } from "../src/bounded-input.ts";
import { CancelledError, UsageError } from "../src/errors.ts";
import { MAX_FEEDBACK_FILE_BYTES, submitFeedback, type FeedbackInput, type FeedbackResult } from "../src/feedback.ts";
import { main, type Io } from "../src/main.ts";
import { renderFormat } from "../src/output/index.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { ScopeResult } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TASK = "Add retry handling to Stripe webhook processing";
const RELEVANCE = { processEvent: 0.9, withRetry: 0.8, computeBackoff: 0.7 };
const FAKE_KEY = "fake-typesafe-key-0123456789abcdef";
const SOURCE_LITERAL = "lastError";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_NAMES = ["SCOPE_CACHE", "SCOPE_FEEDBACK_MAX", "SCOPE_FEEDBACK_MAX_DAYS", "TYPESAFE_API_KEY"];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-feedback-"));
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

let copies = 0;
async function copyFixture(): Promise<string> {
  const repo = join(tmp, `webhook-service-${copies++}`);
  await cp(join(FIXTURES, "webhook-service"), repo, { recursive: true });
  return repo;
}

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const namesWith = async (repo: string, prefix: string) =>
  (await readdir(storeDir(repo)).catch(() => [] as string[])).filter((name) => name.startsWith(prefix)).sort();
const feedbackNames = (repo: string) => namesWith(repo, FEEDBACK_PREFIX);
const later = () => Date.now() + HOUR;

interface RunOptions {
  noJev?: boolean;
  cache?: boolean;
  task?: string;
  reuseDecisions?: boolean;
}
const run = (repo: string, options: RunOptions = {}) =>
  runScope({
    task: options.task ?? TASK,
    repo,
    provider: fakeProvider({ relevance: RELEVANCE, fallback: 0.05 }),
    noJev: options.noJev,
    cache: options.cache ?? true,
    reuseDecisions: options.reuseDecisions,
    explain: true,
    cacheOptions: { now: later, env: {} },
  });

async function open(repo: string): Promise<RepositoryCache> {
  const { cache } = await openRepositoryCache(repo);
  return cache!;
}

/** A repository with one Jev run recorded, and ids to refer to: two selected chunks and one skipped one. */
async function started() {
  const repo = await copyFixture();
  const { result } = await run(repo);
  const runId = result.runId!;
  const ids = result.chunks.map((s) => s.chunk.id);
  return { repo, result, runId, a: ids[0]!, b: ids[1]!, skipped: result.skipped[0]!.chunkId };
}

const give = (repo: string, input: Partial<FeedbackInput> & { runId?: string }, now: () => number = later) =>
  submitFeedback(
    { useful: [], irrelevant: [], missing: [], ...input },
    { repo, env: {}, cacheOptions: { now } },
  ) as Promise<FeedbackResult>;

async function rejected(repo: string, input: Partial<FeedbackInput>, pattern: RegExp) {
  const before = await feedbackNames(repo);
  let error: unknown;
  try {
    await give(repo, input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(UsageError);
  expect((error as Error).message).toMatch(pattern);
  expect(await feedbackNames(repo)).toEqual(before);
  return error as Error;
}

function capture(stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: stdin === undefined ? undefined : async () => stdin,
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}
async function cli(argv: string[], stdin?: string) {
  const c = capture(stdin);
  const code = await main(argv, c.io);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

describe("the run id in the output", () => {
  test("a Jev run reports the history record's id in JSON, text and markdown", async () => {
    const repo = await copyFixture();
    const { result } = await run(repo);
    const [record] = (await readHistory(await open(repo))).records;
    expect(record).toBeDefined();
    expect(result.runId).toBe(record!.runId);
    expect(JSON.parse(renderFormat("json", result)).runId).toBe(record!.runId);
    for (const format of ["text", "markdown"] as const) {
      const rendered = renderFormat(format, result);
      expect(rendered).toContain("scope feedback");
      expect(rendered).toContain(record!.runId);
    }
  });

  test("--no-jev, cache off and zero candidates have no run id", async () => {
    const repo = await copyFixture();
    const noJev = (await run(repo, { noJev: true })).result;
    const off = (await run(repo, { cache: false })).result;
    const empty = join(tmp, "empty");
    await mkdir(empty);
    const none = (await run(empty)).result;
    for (const result of [noJev, off, none]) {
      expect(result.runId).toBeUndefined();
      expect(JSON.parse(renderFormat("json", result)).runId).toBeUndefined();
      expect(renderFormat("text", result)).not.toContain("scope feedback");
    }
  });

  test("a decision-reuse hit reports the original run's id", async () => {
    const repo = await copyFixture();
    const first = (await run(repo)).result;
    const second = (await run(repo, { reuseDecisions: true })).result;
    expect(second.decisionsReusedFrom).toBeDefined();
    expect(first.runId).toBeDefined();
    expect(second.runId).toBe(first.runId);
    expect((await readHistory(await open(repo))).records).toHaveLength(1);
  });

  test("a version 1 decision document (no run id) is a miss", async () => {
    const repo = await copyFixture();
    await run(repo);
    const [name] = await namesWith(repo, DECISION_PREFIX);
    const path = join(storeDir(repo), name!);
    const doc = JSON.parse(await readFile(path, "utf8"));
    doc.record.recordVersion = 1;
    delete doc.record.runId;
    await writeFile(path, JSON.stringify(doc));
    const again = (await run(repo, { reuseDecisions: true })).result;
    expect(again.decisionsReusedFrom).toBeUndefined();
  });
});

describe("recording feedback", () => {
  test("a user submission stores attribution, time and the entries; readFeedback returns it", async () => {
    const { repo, runId, a, b, skipped } = await started();
    const now = later() + 5;
    const result = await give(
      repo,
      {
        runId,
        useful: [a, a],
        irrelevant: [skipped],
        missing: ["src/stripe/handler.ts:1-3", "src/logger.ts", "processEvent"],
      },
      () => now,
    );
    expect(result.source).toEqual({ kind: "user" });
    expect(result.time).toBe(now);
    expect(result.counts).toEqual({ useful: 1, irrelevant: 1, missing: 3 });
    expect(result.warnings).toEqual([]);
    const { records, warnings } = await readFeedback(await open(repo));
    const chunksNow = (await loadChunks(repo)).chunks;
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.feedbackId).toBe(result.feedbackId);
    expect(record!.runId).toBe(runId);
    expect(record!.time).toBe(now);
    expect(record!.source).toEqual({ kind: "user" });
    const fingerprint = (id: string) =>
      createHash("sha256")
        .update(chunksNow.find((chunk) => chunk.id === id)!.content)
        .digest("hex");
    expect(record!.recordVersion).toBe(2);
    expect(record!.useful).toEqual([{ chunkId: a, fingerprint: fingerprint(a), current: true }]);
    expect(record!.irrelevant).toEqual([{ chunkId: skipped, fingerprint: fingerprint(skipped), current: true }]);
    expect(record!.missing[0]).toEqual({ path: "src/stripe/handler.ts", startLine: 1, endLine: 3 });
    expect(record!.missing[1]).toEqual({ path: "src/logger.ts" });
    const symbol = record!.missing[2] as { symbol: string; chunks: { chunkId: string; fingerprint: string }[] };
    expect(symbol.symbol).toBe("processEvent");
    expect(symbol.chunks.length).toBeGreaterThan(0);
    const named = chunksNow.filter((chunk) => chunk.name === "processEvent").slice(0, 20);
    expect(symbol.chunks.map((ref) => ref.chunkId).sort()).toEqual(named.map((chunk) => chunk.id).sort());
    for (const ref of symbol.chunks) expect(ref.fingerprint).toBe(fingerprint(ref.chunkId));
    expect(b).toBeDefined();
  });

  test("--agent attributes the record to the agent", async () => {
    const { repo, runId, a } = await started();
    const result = await give(repo, { runId, useful: [a], agent: "review-bot" });
    expect(result.source).toEqual({ kind: "agent", name: "review-bot" });
    const [record] = (await readFeedback(await open(repo))).records;
    expect(record!.source).toEqual({ kind: "agent", name: "review-bot" });
  });

  test("a chunk edited after the run is current false with a warning; an untouched one stays current", async () => {
    const { repo, result, runId } = await started();
    const target = result.chunks.find((s) => s.chunk.file === "src/util/retry.ts")!.chunk;
    const path = join(repo, target.file);
    const text = await readFile(path, "utf8");
    // Changes a character inside the chunk without moving its start, so the id may stay while the content differs.
    const lines = text.split("\n");
    lines[target.startLine - 1] = `${lines[target.startLine - 1]} // edited`;
    await writeFile(path, lines.join("\n"));
    const fed = await give(repo, { runId, useful: [target.id] }, () => Date.now() + 2 * HOUR);
    const [record] = (await readFeedback(await open(repo))).records;
    expect(record!.useful).toEqual([
      { chunkId: target.id, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), current: false },
    ]);
    expect(fed.warnings).toContain(`chunk ${target.id} changed since run ${runId}`);
  });
});

describe("--file input and the CLI", () => {
  test("a file and stdin merge with the flags; the output line and JSON are as documented", async () => {
    const { repo, runId, a, b, skipped } = await started();
    const file = join(tmp, "feedback.json");
    await writeFile(file, JSON.stringify({ runId, useful: [b], agent: "bot" }));
    const text = await cli(["feedback", runId, "--useful", a, "--irrelevant", skipped, "--file", file, "--repo", repo]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(
      new RegExp(`^Recorded feedback \\d{13}-[0-9a-f]{8} for run ${runId}: 2 useful, 1 irrelevant, 0 missing\n$`),
    );
    const piped = await cli(
      ["feedback", "--file", "-", "--repo", repo, "--format", "json"],
      JSON.stringify({ runId, missing: ["src/logger.ts"] }),
    );
    expect(piped.code).toBe(0);
    const json = JSON.parse(piped.stdout);
    expect(json.runId).toBe(runId);
    expect(json.counts).toEqual({ useful: 0, irrelevant: 0, missing: 1 });
    expect(json.source).toEqual({ kind: "user" });
    expect(json.warnings).toEqual([]);
    const records = (await readFeedback(await open(repo))).records;
    expect(records).toHaveLength(2);
    const merged = records.find((r) => r.source.kind === "agent")!;
    expect(merged.source).toEqual({ kind: "agent", name: "bot" });
    expect(merged.useful.map((r) => r.chunkId).sort()).toEqual([a, b].sort());
  });

  test("a text file in a language without an analyzer is an accepted whole-file --missing target", async () => {
    const { repo, runId } = await started();
    await writeFile(join(repo, "notes.txt"), "plain notes\n");
    const fed = await give(repo, { runId, missing: ["notes.txt", "notes.txt:1-1"] });
    expect(fed.counts.missing).toBe(2);
  });

  test("a NUL byte anywhere makes a file an invalid --missing target, whole or ranged", async () => {
    const { repo, runId } = await started();
    const late = Buffer.concat([
      Buffer.from("export const late = 1;\n".repeat(600)),
      Buffer.from([0]),
      Buffer.from("\n"),
    ]);
    expect(late.indexOf(0)).toBeGreaterThan(8192);
    await writeFile(join(repo, "late.ts"), late);
    await writeFile(join(repo, "early.ts"), Buffer.from("export const early = 1;\n\0\n"));
    for (const value of ["late.ts", "late.ts:1-2", "early.ts", "early.ts:1-1"]) {
      await rejected(repo, { runId, missing: [value] }, /--missing/);
    }
    expect(await feedbackNames(repo)).toEqual([]);
  });

  test("an oversized --file or stdin document is a usage error that records nothing, counting bytes not characters", async () => {
    const { repo, runId, a } = await started();
    const base = { runId, useful: [a] };
    // Under the limit in characters, over it in bytes: 4-byte characters.
    const wide = JSON.stringify({ ...base, agent: "\u{1F600}".repeat(MAX_FEEDBACK_FILE_BYTES / 4 - 10) });
    expect(wide.length).toBeLessThan(MAX_FEEDBACK_FILE_BYTES);
    expect(Buffer.byteLength(wide)).toBeGreaterThan(MAX_FEEDBACK_FILE_BYTES);
    const plain = JSON.stringify({ ...base, agent: "x".repeat(MAX_FEEDBACK_FILE_BYTES) });
    for (const document of [wide, plain]) {
      const file = join(tmp, "big.json");
      await writeFile(file, document);
      const fromFile = await cli(["feedback", "--file", file, "--repo", repo]);
      expect(fromFile.code).toBe(2);
      expect(fromFile.stderr).toContain("larger than");
      const fromStdin = await cli(["feedback", "--file", "-", "--repo", repo], document);
      expect(fromStdin.code).toBe(2);
      expect(fromStdin.stderr).toContain("larger than");
    }
    expect(await feedbackNames(repo)).toEqual([]);
  });

  test("the bounded readers stop as soon as the limit is crossed", async () => {
    let produced = 0;
    async function* endless() {
      while (true) {
        produced++;
        yield Buffer.alloc(1000, 0x61);
      }
    }
    let error: unknown;
    try {
      await readBoundedText(endless(), 5000, "standard input");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect(produced).toBe(6);
    const split = (async function* () {
      yield "h\u00e9";
      yield Buffer.from("llo");
    })();
    expect(await readBoundedText(split, 7, "x")).toBe("h\u00e9llo");
    const file = join(tmp, "limit.txt");
    await writeFile(file, "x".repeat(11));
    await expect(readBoundedFile(file, 10, "limit.txt")).rejects.toBeInstanceOf(UsageError);
    expect(await readBoundedFile(file, 11, "limit.txt")).toBe("x".repeat(11));
  });

  test("a pending read rejects with CancelledError when the signal aborts, and the listener is released", async () => {
    let returned = false;
    const silent: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    // A read that ignores the signal never settles, so each wait is capped and a hang fails fast instead of stalling.
    const settle = (read: Promise<string>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<string>((resolve) => (timer = setTimeout(() => resolve("still pending"), 2000)));
      return Promise.race([read, hung]).finally(() => clearTimeout(timer));
    };
    const started = Date.now();
    await expect(settle(readBoundedText(silent, 100, "standard input", controller.signal))).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(returned).toBe(true);

    const already = new AbortController();
    already.abort();
    await expect(settle(readBoundedText(silent, 100, "x", already.signal))).rejects.toBeInstanceOf(CancelledError);

    const live = new AbortController();
    let removed = 0;
    const remove = live.signal.removeEventListener.bind(live.signal);
    live.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      return remove(...args);
    }) as typeof remove;
    const data = (async function* () {
      yield "ok";
    })();
    expect(await readBoundedText(data, 10, "x", live.signal)).toBe("ok");
    expect(removed).toBe(1);
  });

  test("cancelling a pending read on a real stream destroys it, so an open stdin cannot keep the process alive", async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<string>((resolve) => (timer = setTimeout(() => resolve("still pending"), 2000)));
    await expect(
      Promise.race([readBoundedText(stream, 100, "standard input", controller.signal), hung]).finally(() =>
        clearTimeout(timer),
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(stream.destroyed).toBe(true);

    const large = new PassThrough();
    large.write("x".repeat(11));
    await expect(readBoundedText(large, 10, "standard input")).rejects.toBeInstanceOf(UsageError);
    expect(large.destroyed).toBe(true);
  });

  test("an unknown key, a wrong type and a run id mismatch are usage errors that record nothing", async () => {
    const { repo, runId, a } = await started();
    const other = "1700000000000-0123abcd";
    const cases: [string, string[]][] = [
      [JSON.stringify({ runId, useful: [a], extra: 1 }), []],
      [JSON.stringify({ runId, useful: a }), []],
      [JSON.stringify({ runId, useful: [1] }), []],
      [JSON.stringify([a]), []],
      ["not json", []],
      [JSON.stringify({ runId: other, useful: [a] }), [runId]],
    ];
    for (const [stdin, positional] of cases) {
      const outcome = await cli(["feedback", ...positional, "--file", "-", "--repo", repo], stdin);
      expect(outcome.code).toBe(2);
      expect(outcome.stderr).toContain("scope:");
    }
    expect(await feedbackNames(repo)).toEqual([]);
  });

  test("help, unknown flags and task-run flags", async () => {
    const help = await cli(["feedback", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("scope feedback <run-id>");
    expect(help.stdout).toContain("--missing");
    expect((await cli(["--help"])).stdout).toContain("scope feedback");
    expect((await cli(["feedback", "x", "--bogus"])).code).toBe(2);
    expect((await cli(["feedback", "1700000000000-0123abcd", "--useful", "c", "--no-jev"])).code).toBe(2);
    expect((await cli(["feedback", "1700000000000-0123abcd", "--format", "markdown", "--useful", "c"])).code).toBe(2);
    expect((await cli(["feedback"])).code).toBe(2);
    expect((await cli(["cache", "status", "--useful", "x"])).code).toBe(2);
  });

  test("a rejection exits 2 and writes nothing", async () => {
    const { repo, runId } = await started();
    const outcome = await cli(["feedback", runId, "--useful", "nope", "--repo", repo]);
    expect(outcome.code).toBe(2);
    expect(await feedbackNames(repo)).toEqual([]);
  });
});

describe("rejections record nothing", () => {
  test("run id problems", async () => {
    const { repo, a } = await started();
    await rejected(repo, { useful: [a] }, /run id is required/);
    await rejected(repo, { runId: "nonsense", useful: [a] }, /Not a run id/);
    await rejected(repo, { runId: "1700000000000-0123abcd", useful: [a] }, /Unknown run/);
  });

  test("a run recorded in another repository is unknown here", async () => {
    const source = await started();
    const target = await started();
    await rejected(target.repo, { runId: source.runId, useful: [target.a] }, /Unknown run/);
  });

  test("chunk ids that are not candidates of the run, and ids both useful and irrelevant", async () => {
    const { repo, runId, a, b } = await started();
    await rejected(repo, { runId, useful: [a, "src/nowhere.ts:1-2:fn"] }, /not a candidate of run .*nowhere/);
    await rejected(repo, { runId, irrelevant: ["bogus-id"] }, /--irrelevant: not a candidate/);
    await rejected(repo, { runId, useful: [a, b], irrelevant: [b] }, /both useful and irrelevant/);
  });

  test("empty feedback, too many entries, long entries and bad agent names", async () => {
    const { repo, runId, a } = await started();
    await rejected(repo, { runId }, /Nothing to record/);
    await rejected(repo, { runId, useful: Array.from({ length: 201 }, (_, i) => `id-${i}`) }, /at most 200/);
    await rejected(repo, { runId, missing: ["x".repeat(501)] }, /longer than 500/);
    await rejected(repo, { runId, useful: [""] }, /empty/);
    for (const agent of ["", "   ", "a".repeat(101), "bad\nname", "bad\u0007name"]) {
      await rejected(repo, { runId, useful: [a], agent }, /--agent/);
    }
  });

  test("an agent name that is or contains a credential is refused without echoing it", async () => {
    const { repo, runId, a } = await started();
    process.env.TYPESAFE_API_KEY = FAKE_KEY;
    for (const agent of [FAKE_KEY, `bot ${FAKE_KEY}`, "ghp_" + "a".repeat(36), "AKIA" + "B".repeat(16)]) {
      const error = await rejected(repo, { runId, useful: [a], agent }, /--agent looks like a credential/);
      expect(error.message).not.toContain(agent);
    }
    expect((await give(repo, { runId, useful: [a], agent: "review-bot" })).source).toEqual({
      kind: "agent",
      name: "review-bot",
    });
  });

  test("--missing values: outside the repo, absolute, parent paths, ignored, secret-like and binary files", async () => {
    const { repo, runId } = await started();
    await writeFile(join(repo, ".gitignore"), "ignored.ts\n");
    await writeFile(join(repo, "ignored.ts"), "export const ignored = 1;\n");
    await writeFile(join(repo, ".env"), "TOKEN=abc\n");
    await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const outside = join(tmp, "outside.ts");
    await writeFile(outside, "export const outside = 1;\n");
    await symlink(outside, join(repo, "linked.ts"));
    const cases = [
      "../outside.ts",
      "src/../../outside.ts",
      outside,
      "/etc/hosts",
      "ignored.ts",
      "ignored.ts:1-1",
      ".env",
      "logo.png",
      "linked.ts",
      "nope/missing.ts",
      "src/",
      "src/logger.ts:0-2",
      "src/logger.ts:5-2",
      "src/logger.ts:1-9999",
      "noSuchSymbolAnywhere",
    ];
    for (const value of cases) await rejected(repo, { runId, missing: [value] }, /--missing|range/);
    // Nothing the rejected values name was read into a record.
    expect(await feedbackNames(repo)).toEqual([]);
  });

  test("a rejection among valid entries records none of them (all or nothing)", async () => {
    const { repo, runId, a } = await started();
    await rejected(repo, { runId, useful: [a], missing: ["src/logger.ts", "noSuchSymbolAnywhere"] }, /--missing/);
  });
});

describe("feedback does not alter runs", () => {
  test("a run after feedback is identical apart from the run id and still reuses the decisions", async () => {
    const repo = await copyFixture();
    const first = (await run(repo)).result;
    const historyBefore = (await readHistory(await open(repo))).records;
    await give(repo, {
      runId: first.runId,
      useful: [first.chunks[0]!.chunk.id],
      irrelevant: [first.skipped[0]!.chunkId],
      missing: ["src/logger.ts"],
    });
    const second = (await run(repo, { reuseDecisions: true })).result;
    expect(second.decisionsReusedFrom).toBeDefined();
    const strip = (r: ScopeResult) => ({
      chunks: r.chunks,
      regions: r.regions,
      skipped: r.skipped,
      warnings: r.warnings.filter((w) => !/reused|Reused/.test(w)),
      runId: r.runId,
    });
    expect(strip(second)).toEqual(strip(first));
    expect((await readHistory(await open(repo))).records).toEqual(historyBefore);
    const fresh = (await run(repo, { reuseDecisions: false })).result;
    expect(fresh.chunks).toEqual(first.chunks);
    expect(fresh.regions).toEqual(first.regions);
    expect(fresh.skipped).toEqual(first.skipped);
  });
});

describe("integrity", () => {
  async function seeded() {
    const s = await started();
    const fed = await give(s.repo, { runId: s.runId, useful: [s.a] });
    const name = `${FEEDBACK_PREFIX}${fed.feedbackId}.json`;
    const path = join(storeDir(s.repo), name);
    return { ...s, name, path, doc: JSON.parse(await readFile(path, "utf8")) };
  }

  test("a tampered record keeps its old MAC and is skipped", async () => {
    const s = await seeded();
    s.doc.record.useful[0].current = false;
    await writeFile(s.path, JSON.stringify(s.doc));
    const { records, warnings } = await readFeedback(await open(s.repo));
    expect(records).toEqual([]);
    expect(warnings).toEqual([`${s.name}: not signed by this user; ignoring it`]);
  });

  test("a record under another name, signed under another key, or copied from another repository is skipped", async () => {
    const s = await seeded();
    const text = await readFile(s.path, "utf8");
    await writeFile(join(storeDir(s.repo), `${FEEDBACK_PREFIX}0000000000001-00000000.json`), text);
    const cache = await open(s.repo);
    const foreign = { ...s.doc, mac: feedbackMac({ ...cache, integrityKey: randomBytes(32) }, s.doc.record) };
    const foreignName = `${FEEDBACK_PREFIX}0000000000002-00000000.json`;
    await writeFile(
      join(storeDir(s.repo), foreignName),
      JSON.stringify({ ...foreign, record: { ...s.doc.record, feedbackId: "0000000000002-00000000" } }),
    );
    const other = await started();
    await give(other.repo, { runId: other.runId, useful: [other.a] });
    const [otherName] = await feedbackNames(other.repo);
    await writeFile(join(storeDir(s.repo), otherName!.replace(/^feedback-\d+/, "feedback-9999999999999")), "x");
    const copied = await readFile(join(storeDir(other.repo), otherName!), "utf8");
    await writeFile(join(storeDir(s.repo), otherName!), copied);
    const { records, warnings } = await readFeedback(cache);
    expect(records.map((r) => r.feedbackId)).toEqual([s.doc.record.feedbackId]);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("corrupt JSON is skipped with a warning and never an error", async () => {
    const s = await seeded();
    await writeFile(join(storeDir(s.repo), `${FEEDBACK_PREFIX}0000000000003-00000000.json`), "{not json");
    const { records, warnings } = await readFeedback(await open(s.repo));
    expect(records).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  test("unverified and unparseable documents are pruned at the next write and take no slot", async () => {
    const s = await seeded();
    const planted = [`${FEEDBACK_PREFIX}0000000000001-00000000.json`, `${FEEDBACK_PREFIX}bad.json`];
    await writeFile(join(storeDir(s.repo), planted[0]!), await readFile(s.path, "utf8"));
    await writeFile(join(storeDir(s.repo), planted[1]!), "{}");
    const second = await give(s.repo, { runId: s.runId, useful: [s.b] }, () => Date.now() + 2 * HOUR);
    const names = await feedbackNames(s.repo);
    expect(names).toEqual([s.name, `${FEEDBACK_PREFIX}${second.feedbackId}.json`].sort());
    expect((await readFeedback(await open(s.repo))).warnings).toEqual([]);
  });

  test("planted documents newer than real feedback cannot evict it from a full store", async () => {
    const s = await seeded();
    const newer = (Date.now() + 3 * HOUR).toString().padStart(13, "0");
    for (const suffix of ["00000001", "00000002"]) {
      const id = `${newer}-${suffix}`;
      await writeFile(
        join(storeDir(s.repo), `${FEEDBACK_PREFIX}${id}.json`),
        JSON.stringify({ ...s.doc, record: { ...s.doc.record, feedbackId: id } }),
      );
    }
    const second = await submitFeedback(
      { runId: s.runId, useful: [s.b], irrelevant: [], missing: [] },
      { repo: s.repo, env: { SCOPE_FEEDBACK_MAX: "2" }, cacheOptions: { now: () => Date.now() + 2 * HOUR } },
    );
    const kept = (await readFeedback(await open(s.repo))).records.map((r) => r.feedbackId);
    expect(kept).toEqual([second.feedbackId, s.doc.record.feedbackId]);
    expect(await feedbackNames(s.repo)).toHaveLength(2);
  });
});

describe("retention", () => {
  test("SCOPE_FEEDBACK_MAX keeps the newest records", async () => {
    const { repo, runId, a } = await started();
    const base = Date.now() + HOUR;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const fed = await submitFeedback(
        { runId, useful: [a], irrelevant: [], missing: [] },
        { repo, env: { SCOPE_FEEDBACK_MAX: "2" }, cacheOptions: { now: () => base + i * 1000 } },
      );
      ids.push(fed.feedbackId);
    }
    const kept = (await readFeedback(await open(repo))).records.map((r) => r.feedbackId);
    expect(kept).toEqual([ids[3]!, ids[2]!]);
    expect(await feedbackNames(repo)).toHaveLength(2);
  });

  test("records older than SCOPE_FEEDBACK_MAX_DAYS are removed by the next write", async () => {
    const { repo, runId, a } = await started();
    const base = Date.now() + HOUR;
    const env = { SCOPE_FEEDBACK_MAX_DAYS: "2" };
    const old = await submitFeedback(
      { runId, useful: [a], irrelevant: [], missing: [] },
      { repo, env, cacheOptions: { now: () => base } },
    );
    const fresh = await submitFeedback(
      { runId, useful: [a], irrelevant: [], missing: [] },
      { repo, env, cacheOptions: { now: () => base + 3 * DAY } },
    );
    const kept = (await readFeedback(await open(repo))).records.map((r) => r.feedbackId);
    expect(kept).toEqual([fresh.feedbackId]);
    expect(kept).not.toContain(old.feedbackId);
  });

  test("a bound of 0 and the cache off are usage errors that write nothing", async () => {
    const { repo, runId, a } = await started();
    const input = { runId, useful: [a], irrelevant: [], missing: [] };
    for (const env of [{ SCOPE_FEEDBACK_MAX: "0" }, { SCOPE_FEEDBACK_MAX_DAYS: "0" }, { SCOPE_CACHE: "off" }]) {
      let error: unknown;
      try {
        await submitFeedback(input, { repo, env });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toMatch(/needs the local cache/);
    }
    expect(await feedbackNames(repo)).toEqual([]);
    process.env.SCOPE_CACHE = "off";
    expect((await cli(["feedback", runId, "--useful", a, "--repo", repo])).code).toBe(2);
  });

  test("recordFeedback with a bound of 0 writes nothing and removes what is there", async () => {
    const { repo, runId, a } = await started();
    await give(repo, { runId, useful: [a] });
    const cache = await open(repo);
    const record: FeedbackRecord = {
      recordVersion: 2,
      feedbackId: "9999999999999-00000000",
      runId,
      time: 9_999_999_999_999,
      source: { kind: "user" },
      useful: [{ chunkId: a, fingerprint: "a".repeat(64), current: true }],
      irrelevant: [],
      missing: [],
    };
    const outcome = await recordFeedback(cache, record, { env: { SCOPE_FEEDBACK_MAX: "0" }, now: Date.now() });
    expect(outcome.committed).toBe(true);
    expect(outcome.recorded).toBe(false);
    expect(await feedbackNames(repo)).toEqual([]);
  });
});

describe("what is never stored", () => {
  test("no task text, source literal or API key reaches a feedback document", async () => {
    const { repo, runId, a, result } = await started();
    process.env.TYPESAFE_API_KEY = FAKE_KEY;
    const source = await readFile(join(repo, "src/util/retry.ts"), "utf8");
    expect(source).toContain(SOURCE_LITERAL);
    await give(repo, { runId, useful: [a], missing: ["processEvent", "src/util/retry.ts:1-3"], agent: "bot" });
    const [name] = await feedbackNames(repo);
    const text = await readFile(join(storeDir(repo), name!), "utf8");
    expect(text).not.toContain(TASK);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(SOURCE_LITERAL);
    for (const selected of result.chunks) expect(text).not.toContain(selected.chunk.content.slice(0, 80));
  });
});

describe("cache commands", () => {
  const feedbackCount = async (repo: string) =>
    JSON.parse((await cli(["cache", "status", "--repo", repo, "--format", "json"])).stdout).documents.feedback;

  test("status counts feedback, rebuild keeps it and clear removes it", async () => {
    const { repo, runId, a } = await started();
    expect(await feedbackCount(repo)).toBe(0);
    await give(repo, { runId, useful: [a] });
    await give(repo, { runId, useful: [a] }, () => Date.now() + 2 * HOUR);
    expect(await feedbackCount(repo)).toBe(2);
    expect((await cli(["cache", "status", "--repo", repo])).stdout).toMatch(/feedback:\s+2/);
    expect((await cli(["cache", "rebuild", "--repo", repo])).code).toBe(0);
    expect(await feedbackNames(repo)).toHaveLength(2);
    expect((await readFeedback(await open(repo))).records).toHaveLength(2);
    expect((await cli(["cache", "clear", "--repo", repo, "--yes"])).code).toBe(0);
    expect(await readdir(join(repo, ".scope")).catch(() => [])).not.toContain("store-v1");
    expect(await feedbackNames(repo)).toEqual([]);
  });
});
