import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFeedback } from "../src/cache/feedback.ts";
import { readHistory } from "../src/cache/history.ts";
import { openRepositoryCache } from "../src/cache/location.ts";
import { addMemoryCandidates } from "../src/cache/memory.ts";
import { submitFeedback, type FeedbackInput } from "../src/feedback.ts";
import { renderFormat } from "../src/output/index.ts";
import type { VersionKeys } from "../src/cache/versions.ts";
import { fileReport, loadChunks, runScope } from "../src/scope.ts";
import type { ScopeResult } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

/**
 * Golden files for what a run reports about the cache (#79): a cold run, a warm run (one edited file, memory
 * candidates with their reasons, user and agent feedback) and an exact repeat that reuses the Jev decision. Real
 * `runScope` runs on a temporary repository with a fake provider. Only run ids and ISO times are normalized.
 * Regenerate with `UPDATE_GOLDEN=1 bun test tests/golden-cache.test.ts` and review the diff.
 */
const DIR = join(import.meta.dir, "golden/cache");
const HOUR = 3_600_000;
const T_WIDGETS = "nightly batch job frobnicate widgets";
const T_NOW = "nightly batch job reconcile ledger";
const RELEVANCE = { frobnicateWidgets: 0.9, frobnicateGadgets: 0.05, reconcileLedger: 0.9 };
// Once the agent has reported it missing, Jev finds the gadgets relevant.
const WARM = { ...RELEVANCE, frobnicateGadgets: 0.8 };
// Fixed, so the goldens do not move with an installed parser or grammar version.
const KEYS: VersionKeys = {
  store: 1,
  scope: "0.0.0",
  analyzer: "analyzer-golden",
  treeSitter: "tree-sitter-golden",
  grammars: { typescript: "1.0.0" },
};
const SHORTLIST = { shortlistSize: 6, expansion: { seedCount: 3, maxNeighborsPerSeed: 2, maxExpanded: 3 } };

let tmp: string;
let state: string;
let clock = 0;
const now = () => (clock += 1000);
const saved: Record<string, string | undefined> = {};
const ENV_NAMES = ["SCOPE_CACHE", "SCOPE_MEMORY", "TYPESAFE_API_KEY"];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-golden-cache-"));
  state = join(tmp, "state");
  // An hour ahead of the files, so no stat record is racy.
  clock = Date.now() + HOUR;
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

const fn = (name: string, body: string) => `export function ${name}(x: number) {\n  return ${body};\n}\n`;
async function makeRepo(name = "repo"): Promise<string> {
  const repo = join(tmp, name);
  await mkdir(join(repo, "src/ledger"), { recursive: true });
  await mkdir(join(repo, "src/misc"), { recursive: true });
  await writeFile(join(repo, "src/ledger/reconcile.ts"), fn("reconcileLedger", "x + 1"));
  await writeFile(join(repo, "src/misc/zebra.ts"), fn("frobnicateWidgets", "x * 2"));
  await writeFile(join(repo, "src/misc/zebra2.ts"), fn("frobnicateGadgets", "x * 3"));
  for (let i = 0; i < 4; i++) await writeFile(join(repo, `src/misc/filler${i}.ts`), fn(`filler${i}Thing`, `x + ${i}`));
  return repo;
}

interface RunOptions {
  task?: string;
  cache?: boolean;
  noJev?: boolean;
  relevance?: Record<string, number>;
}
const run = (repo: string, options: RunOptions = {}) =>
  runScope({
    task: options.task ?? T_NOW,
    repo,
    provider: fakeProvider({ relevance: options.relevance ?? RELEVANCE, fallback: 0.05 }),
    noJev: options.noJev,
    cache: options.cache ?? true,
    explain: true,
    retrieval: SHORTLIST,
    cacheOptions: { now, env: {}, keys: KEYS, integrityEnv: { XDG_STATE_HOME: state } },
  }).then(({ result }) => result);

const give = (repo: string, input: Partial<FeedbackInput> & { runId: string }) =>
  submitFeedback(
    { useful: [], irrelevant: [], missing: [], ...input },
    { repo, env: {}, cacheOptions: { now, keys: KEYS, integrityEnv: { XDG_STATE_HOME: state } } },
  );

/** Run ids and ISO times become stable placeholders (run ids numbered by first appearance). */
function normalize(text: string): string {
  const ids = new Map<string, string>();
  return text
    .replace(/\b[0-9]{13}-[0-9a-f]{8}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, `RUN-${ids.size + 1}`);
      return ids.get(id)!;
    })
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<time>");
}

async function expectGolden(name: string, actual: string): Promise<void> {
  const file = join(DIR, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, actual);
  }
  expect(actual).toBe(await readFile(file, "utf8"));
}

const json = (result: ScopeResult) => normalize(renderFormat("json", result));

/** The three runs of the goldens, in order, on one repository. */
async function threeRuns() {
  const repo = await makeRepo();
  const cold = await run(repo, { task: T_WIDGETS });
  // A reviewer finds widgets useful and, as an agent, reports a missing symbol; then one file is edited.
  await give(repo, {
    runId: cold.runId!,
    useful: [cold.chunks.find((s) => s.chunk.name === "frobnicateWidgets")!.chunk.id],
  });
  await give(repo, { runId: cold.runId!, missing: ["frobnicateGadgets"], agent: "review-bot" });
  // Feedback reads the repository too, so the edit comes after it.
  await writeFile(join(repo, "src/misc/filler0.ts"), fn("filler0Thing", "x + 100"));
  const warm = await run(repo, { relevance: WARM });
  const reused = await run(repo, { relevance: WARM });
  return { repo, cold, warm, reused };
}

describe("golden cache reports", () => {
  test("a cold run reports every file refreshed and no reuse", async () => {
    const { cold } = await threeRuns();
    expect(cold.cache!.cold).toBe(true);
    expect(cold.cache!.decision).toEqual({ reused: false });
    await expectGolden("cold.json", json(cold));
  });

  test("a warm run reports one refreshed file, reused files and memory reasons", async () => {
    const { warm } = await threeRuns();
    expect(warm.cache!.cold).toBe(false);
    expect(warm.cache!.files).toMatchObject({ reused: 6, refreshed: 1, removed: 0 });
    expect(warm.cache!.files.refreshedPaths).toEqual(["src/misc/filler0.ts"]);
    const gadgets = warm.chunks.find((s) => s.chunk.name === "frobnicateGadgets")!;
    expect(gadgets.memory?.feedback).toEqual({ useful: 0, irrelevant: 0, missing: 1, sources: ["agent:review-bot"] });
    await expectGolden("warm.json", json(warm));
  });

  test("an exact repeat reports the reused decision", async () => {
    const { reused } = await threeRuns();
    expect(reused.cache!.decision?.reused).toBe(true);
    expect(reused.cache!.decision?.expiresAt).toBeDefined();
    expect(reused.decisionsReusedFrom).toBeDefined();
    await expectGolden("reuse.json", json(reused));
  });

  test.each([
    ["text", "txt"],
    ["markdown", "md"],
  ] as const)("the warm run's %s output with --explain", async (format, extension) => {
    const { warm } = await threeRuns();
    const text = normalize(renderFormat(format, warm));
    expect(text).toContain("Memory: ");
    await expectGolden(`warm.explain.${extension}`, text);
  });
});

describe("cache report", () => {
  test("is absent with the cache off", async () => {
    const repo = await makeRepo();
    const result = await run(repo, { cache: false });
    expect(result.cache).toBeUndefined();
    expect(JSON.parse(renderFormat("json", result)).cache).toBeUndefined();
    expect(renderFormat("text", result)).not.toContain("cache:");
    expect(renderFormat("markdown", result)).not.toContain("cache:");
  });

  test("with --no-jev has the file counts but no decision, memory or weights", async () => {
    const repo = await makeRepo();
    await run(repo, { task: T_WIDGETS });
    const result = await run(repo, { noJev: true });
    expect(result.cache!.files).toMatchObject({ reused: 7, refreshed: 0, removed: 0, refreshedPaths: [] });
    expect(result.cache!.cold).toBe(false);
    expect(result.cache!.decision).toBeUndefined();
    expect(result.cache!.memory).toBeUndefined();
    expect(result.cache!.weights).toBeUndefined();
    expect(renderFormat("text", result)).toContain("cache: 7 files reused, 0 refreshed, 0 removed");
  });

  test("counts a file removed since the last run", async () => {
    const repo = await makeRepo();
    await run(repo);
    await rm(join(repo, "src/misc/filler1.ts"));
    const result = await run(repo);
    expect(result.cache!.files).toMatchObject({ reused: 6, refreshed: 0, removed: 1 });
  });

  test("reports no more than 50 refreshed paths, sorted, and flags the truncation", () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/f${String(59 - i).padStart(2, "0")}.ts`);
    const files = fileReport({ reused: 3, analyzed: 60 }, { removed: 2, refreshedPaths: paths });
    expect(files.refreshed).toBe(60);
    expect(files.reused).toBe(3);
    expect(files.removed).toBe(2);
    expect(files.refreshedPaths).toHaveLength(50);
    expect(files.refreshedPaths[0]).toBe("src/f00.ts");
    expect(files.refreshedPaths[49]).toBe("src/f49.ts");
    expect(files.refreshedTruncated).toBe(true);
    const exact = fileReport({ reused: 0, analyzed: 50 }, { removed: 0, refreshedPaths: paths.slice(0, 50) });
    expect(exact.refreshedPaths).toHaveLength(50);
    expect(exact.refreshedTruncated).toBeUndefined();
  });

  test("lists at most 10 feedback sources, sorted", async () => {
    const repo = await makeRepo();
    const cold = await run(repo, { task: T_WIDGETS });
    for (let i = 11; i >= 0; i--) {
      await give(repo, {
        runId: cold.runId!,
        missing: ["frobnicateGadgets"],
        agent: `bot-${String(i).padStart(2, "0")}`,
      });
    }
    const warm = await run(repo, { relevance: WARM });
    const sources = warm.chunks.find((s) => s.chunk.name === "frobnicateGadgets")!.memory!.feedback!.sources;
    expect(sources).toHaveLength(10);
    expect(sources[0]).toBe("agent:bot-00");
    expect(sources[9]).toBe("agent:bot-09");
  });

  test("passes feedback sources through credential redaction", async () => {
    const repo = await makeRepo();
    const cold = await run(repo, { task: T_WIDGETS });
    await give(repo, { runId: cold.runId!, missing: ["frobnicateGadgets"], agent: "review-bot" });
    const key = "fake-typesafe-key-0123456789abcdef";
    const env = { XDG_STATE_HOME: state };
    const loaded = await loadChunks(repo, { cache: { integrityEnv: env, keys: KEYS } });
    const { cache } = await openRepositoryCache(repo, { integrityEnv: env, keys: KEYS });
    const history = await readHistory(cache!);
    const feedback = await readFeedback(cache!);
    // A source that reached storage some other way (the entry check should have refused it) is still redacted.
    const tampered = feedback.records.map((record) => ({ ...record, source: { kind: "agent" as const, name: key } }));
    process.env.TYPESAFE_API_KEY = key;
    const outcome = addMemoryCandidates({
      task: T_NOW,
      chunks: loaded.chunks,
      files: new Set(loaded.chunks.map((chunk) => chunk.file)),
      fresh: { candidates: [], ranking: new Map() },
      history: history.records,
      feedback: tampered,
      config: { maxCandidates: 5, similarityMin: 0.3, maxRuns: 20 },
    });
    const id = loaded.chunks.find((chunk) => chunk.name === "frobnicateGadgets")!.id;
    const gadgets = outcome.ranking.get(id)!;
    expect(gadgets.memory?.feedback?.sources).toEqual(["agent:[REDACTED]"]);
    expect(JSON.stringify(gadgets)).not.toContain(key);
  });
});
