import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TASK_CHARS } from "../src/cache/history.ts";
import { addMemoryCandidates, memoryEnabled, similarity } from "../src/cache/memory.ts";
import { submitFeedback, type FeedbackInput } from "../src/feedback.ts";
import { planJevRequests } from "../src/jev/provider.ts";
import { renderFormat } from "../src/output/index.ts";
import type { DeepPartial, RetrievalConfig } from "../src/retrieval/config.ts";
import { previewJevPayload, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider, ScopeResult } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

// The chunks: reconcileLedger (found by the current tasks), frobnicateWidgets and frobnicateGadgets (found only by
// the `frobnicate` tasks), and filler. Memory is what brings the frobnicate chunks into a "reconcile ledger" task.
const T_WIDGETS = "nightly batch job frobnicate widgets";
const T_GADGETS = "nightly batch job frobnicate gadgets";
const T_FROB = "nightly batch job frobnicate";
const T_NOW = "nightly batch job reconcile ledger";
const SEED_RELEVANCE = { frobnicateWidgets: 0.9, frobnicateGadgets: 0.05, reconcileLedger: 0.9 };

const NO_MEMORY = { SCOPE_MEMORY: "off" };
const SHORTLIST = {
  shortlistSize: 6,
  expansion: { seedCount: 3, maxNeighborsPerSeed: 2, maxExpanded: 3 },
};

let tmp: string;
let clock = 0;
const now = () => (clock += 1000);
const saved: Record<string, string | undefined> = {};
const ENV_NAMES = ["SCOPE_CACHE", "SCOPE_MEMORY", "TYPESAFE_API_KEY"];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-memory-"));
  clock = Date.now();
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

let repos = 0;
const fn = (name: string, body: string) => `export function ${name}(x: number) {\n  return ${body};\n}\n`;
async function makeRepo(): Promise<string> {
  const repo = join(tmp, `repo-${repos++}`);
  await mkdir(join(repo, "src/ledger"), { recursive: true });
  await mkdir(join(repo, "src/misc"), { recursive: true });
  await writeFile(join(repo, "src/ledger/reconcile.ts"), fn("reconcileLedger", "x + 1"));
  await writeFile(join(repo, "src/misc/zebra.ts"), fn("frobnicateWidgets", "x * 2"));
  await writeFile(join(repo, "src/misc/zebra2.ts"), fn("frobnicateGadgets", "x * 3"));
  for (let i = 0; i < 8; i++) await writeFile(join(repo, `src/misc/filler${i}.ts`), fn(`filler${i}Thing`, `x + ${i}`));
  return repo;
}

/** A provider that records what it was asked to judge. */
function recording(relevance: Record<string, number>) {
  const inner = fakeProvider({ relevance, fallback: 0.05 });
  const calls: CodeChunk[][] = [];
  const provider: DecisionProvider = {
    decisionCacheKey: inner.decisionCacheKey,
    async decide(input) {
      calls.push([...input.candidates]);
      return inner.decide(input);
    },
  };
  return { provider, calls, names: (call = calls.length - 1) => calls[call]!.map((chunk) => chunk.name) };
}

interface RunOptions {
  relevance?: Record<string, number>;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  noJev?: boolean;
  memory?: DeepPartial<RetrievalConfig>["memory"];
  rec?: ReturnType<typeof recording>;
}
async function run(repo: string, task: string, options: RunOptions = {}) {
  const rec = options.rec ?? recording(options.relevance ?? SEED_RELEVANCE);
  const { result } = await runScope({
    task,
    repo,
    provider: rec.provider,
    noJev: options.noJev,
    cache: options.cache ?? true,
    explain: true,
    retrieval: { ...SHORTLIST, ...(options.memory ? { memory: options.memory } : {}) },
    cacheOptions: { now, env: options.env ?? {} },
  });
  return { result, rec };
}

/** Records history for `task` without letting memory shape it. */
const seed = (repo: string, task: string, relevance: Record<string, number> = SEED_RELEVANCE) =>
  run(repo, task, { relevance, env: NO_MEMORY });

const give = (repo: string, input: Partial<FeedbackInput> & { runId: string }) =>
  submitFeedback({ useful: [], irrelevant: [], missing: [], ...input }, { repo, env: {}, cacheOptions: { now } });

const idOf = (result: ScopeResult, name: string) => result.chunks.find((s) => s.chunk.name === name)!.chunk.id;
const find = (result: ScopeResult, name: string) => result.chunks.find((s) => s.chunk.name === name);

describe("memory candidates", () => {
  test("a Jev-selected chunk of a similar task is appended last, labeled and half-weighted", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    const { result, rec } = await run(repo, T_NOW);
    const runId = first.result.runId!;

    expect(rec.names()).toEqual(["reconcileLedger", "frobnicateWidgets"]);
    const memory = find(result, "frobnicateWidgets")!;
    expect(memory.origin).toBe(`memory: similar task ${runId}`);
    expect(memory.signals.memory).toBe(0.5);
    // Memory only appends and orders candidates; the score is Jev's relevance, as for every candidate.
    expect(memory.score).toBe(memory.relevance!);
    const json = JSON.parse(renderFormat("json", result));
    const chunks = json.regions.flatMap((region: { chunks: { name?: string; origin?: string }[] }) => region.chunks);
    expect(chunks.find((c: { name?: string }) => c.name === "frobnicateWidgets").origin).toBe(
      `memory: similar task ${runId}`,
    );
    expect(renderFormat("text", result)).toContain(`Origin: memory: similar task ${runId}`);
  });

  test("when only memory supplies candidates, the warning says Jev judges remembered chunks", async () => {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    const { result, rec } = await run(repo, "nightly batch job");
    expect(rec.names()).toEqual(["frobnicateWidgets"]);
    expect(result.warnings.join("\n")).not.toContain("nothing to judge");
    expect(result.warnings.join("\n")).toContain("Jev judges only the 1 remembered candidate from similar tasks");
  });

  test("fresh candidates keep their order, signals, scores and origin", async () => {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    const baseline = await run(repo, T_NOW, { cache: false });
    const withMemory = await run(repo, T_NOW);

    const fresh = baseline.rec.calls[0]!.map((chunk) => chunk.id);
    expect(withMemory.rec.calls[0]!.map((chunk) => chunk.id).slice(0, fresh.length)).toEqual(fresh);
    expect(withMemory.rec.calls[0]!.length).toBe(fresh.length + 1);
    const before = find(baseline.result, "reconcileLedger")!;
    const after = find(withMemory.result, "reconcileLedger")!;
    expect(after.signals).toEqual(before.signals);
    expect("memory" in after.signals).toBe(false);
    expect(after.score).toBe(before.score);
    expect(after.origin).toBe(before.origin);
  });

  test("a new file that matches the task is still found next to the remembered chunks", async () => {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    await writeFile(join(repo, "src/ledger/audit.ts"), fn("auditLedgerTotals", "x - 1"));
    const { rec } = await run(repo, T_NOW, { relevance: { auditLedgerTotals: 0.9 } });
    const names = rec.names();
    expect(names).toContain("auditLedgerTotals");
    expect(names).toContain("reconcileLedger");
    // Fresh candidates first; the remembered chunk comes last.
    expect(names.at(-1)).toBe("frobnicateWidgets");
  });

  test("a chunk named by --missing feedback comes first, at the full signal, ahead of Jev-only chunks", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, missing: ["frobnicateGadgets"] });
    const { result, rec } = await run(repo, T_NOW, { relevance: { ...SEED_RELEVANCE, frobnicateGadgets: 0.9 } });
    expect(rec.names()).toEqual(["reconcileLedger", "frobnicateGadgets", "frobnicateWidgets"]);
    const gadgets = find(result, "frobnicateGadgets")!;
    expect(gadgets.origin).toBe(`memory: missing in similar task ${first.result.runId}`);
    expect(gadgets.signals.memory).toBe(1);
    expect(find(result, "frobnicateWidgets")!.signals.memory).toBe(0.5);
    expect(renderFormat("text", result)).toContain("Origin: memory: missing in similar task");
  });

  test("a path-level --missing entry brings in the chunks of that file", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, missing: ["src/misc/zebra2.ts"] });
    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toContain("frobnicateGadgets");
  });

  test("a path-level --missing entry does not bring in code that changed since the feedback", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, missing: ["src/misc/zebra2.ts"] });
    await writeFile(join(repo, "src/misc/zebra2.ts"), fn("frobnicateGadgets", "x * 300"));
    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger", "frobnicateWidgets"]);
  });

  test("a chunk confirmed useful by feedback is labeled as similar-task memory at the full signal", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, useful: [idOf(first.result, "frobnicateWidgets")] });
    const { result } = await run(repo, T_NOW);
    const widgets = find(result, "frobnicateWidgets")!;
    expect(widgets.signals.memory).toBe(1);
    expect(widgets.origin).toBe(`memory: similar task ${first.result.runId}`);
  });

  test("a chunk confirmed irrelevant is never added", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    // Irrelevant reports outweigh the one missing report (a tie would be neither).
    const widgets = idOf(first.result, "frobnicateWidgets");
    await give(repo, { runId: first.result.runId!, irrelevant: [widgets], missing: ["src/misc/zebra.ts"] });
    await give(repo, { runId: first.result.runId!, irrelevant: [widgets] });
    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger"]);
  });

  test("a dissimilar earlier task adds nothing", async () => {
    const repo = await makeRepo();
    await seed(repo, "weekend payroll export frobnicate widgets");
    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger"]);
  });

  test("the similarity threshold is configurable", async () => {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    const strict = await run(repo, T_NOW, { memory: { similarityMin: 0.9 } });
    expect(strict.rec.names()).toEqual(["reconcileLedger"]);
    const loose = await run(repo, T_NOW, { memory: { similarityMin: 0.3 } });
    expect(loose.rec.names()).toContain("frobnicateWidgets");
  });

  test("at most maxCandidates are added", async () => {
    const repo = await makeRepo();
    await seed(repo, T_FROB, { frobnicateWidgets: 0.9, frobnicateGadgets: 0.9 });
    const all = await run(repo, T_NOW);
    expect(all.rec.names()).toEqual(["reconcileLedger", "frobnicateWidgets", "frobnicateGadgets"]);
    const capped = await run(repo, T_NOW, { memory: { maxCandidates: 1 } });
    expect(capped.rec.names()).toEqual(["reconcileLedger", "frobnicateWidgets"]);
  });

  test("only the newest maxRuns similar runs count", async () => {
    // A probe run is history too, so each limit gets its own repository with the same two earlier runs.
    const probe = async (maxRuns: number) => {
      const repo = await makeRepo();
      await seed(repo, T_WIDGETS, { frobnicateWidgets: 0.9 });
      await seed(repo, T_GADGETS, { frobnicateGadgets: 0.9 });
      return (await run(repo, T_NOW, { memory: { maxRuns } })).rec.names();
    };
    expect(await probe(2)).toEqual(["reconcileLedger", "frobnicateWidgets", "frobnicateGadgets"]);
    expect(await probe(1)).toEqual(["reconcileLedger", "frobnicateGadgets"]);
  });
});

describe("memory never resurrects stale code", () => {
  async function seeded() {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    const runId = first.result.runId!;
    await give(repo, { runId, useful: [idOf(first.result, "frobnicateWidgets")], missing: ["frobnicateWidgets"] });
    return { repo, id: idOf(first.result, "frobnicateWidgets") };
  }

  test("a deleted chunk is not a candidate and nothing references it", async () => {
    const { repo, id } = await seeded();
    await rm(join(repo, "src/misc/zebra.ts"));
    const { result, rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger"]);
    const rendered = JSON.stringify(result) + renderFormat("text", result);
    expect(rendered).not.toContain(id);
    expect(rendered).not.toContain("frobnicateWidgets");
    expect(rendered).not.toContain("memory:");
  });

  test("an edited chunk is not a candidate", async () => {
    const { repo } = await seeded();
    await writeFile(join(repo, "src/misc/zebra.ts"), fn("frobnicateWidgets", "x * 200"));
    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger"]);
  });
});

describe("memory off switches", () => {
  async function seeded() {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    const baseline = await run(repo, T_NOW, { cache: false });
    // Not vacuous: with memory on, this repository does get a memory candidate.
    const on = await run(repo, T_NOW);
    expect(on.rec.names()).toContain("frobnicateWidgets");
    return { repo, baseline: baseline.rec.names() };
  }

  test("SCOPE_MEMORY=off gives the memory-free shortlist", async () => {
    const { repo, baseline } = await seeded();
    expect((await run(repo, T_NOW, { env: NO_MEMORY })).rec.names()).toEqual(baseline);
  });

  test("any other SCOPE_MEMORY value leaves memory on", () => {
    expect(memoryEnabled({})).toBe(true);
    expect(memoryEnabled({ SCOPE_MEMORY: "on" })).toBe(true);
    expect(memoryEnabled({ SCOPE_MEMORY: "off" })).toBe(false);
  });

  test("maxCandidates 0 gives the memory-free shortlist", async () => {
    const { repo, baseline } = await seeded();
    expect((await run(repo, T_NOW, { memory: { maxCandidates: 0 } })).rec.names()).toEqual(baseline);
  });

  test("the cache off gives the memory-free shortlist", async () => {
    const { repo, baseline } = await seeded();
    expect((await run(repo, T_NOW, { cache: false })).rec.names()).toEqual(baseline);
  });

  test("history past its retention age gives the memory-free shortlist, before any pruning", async () => {
    const { repo, baseline } = await seeded();
    clock += 91 * 86_400_000;
    expect((await run(repo, T_NOW)).rec.names()).toEqual(baseline);
  });

  test("history retention turned off gives the memory-free shortlist", async () => {
    const { repo, baseline } = await seeded();
    expect((await run(repo, T_NOW, { env: { SCOPE_HISTORY_MAX_RUNS: "0" } })).rec.names()).toEqual(baseline);
  });

  test("feedback retention turned off drops what only feedback remembered", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, missing: ["frobnicateGadgets"] });
    const relevance = { ...SEED_RELEVANCE, frobnicateGadgets: 0.9 };
    const { rec } = await run(repo, T_NOW, { relevance, env: { SCOPE_FEEDBACK_MAX: "0" } });
    expect(rec.names()).toEqual(["reconcileLedger", "frobnicateWidgets"]);
  });

  test("--no-jev never uses memory", async () => {
    const { repo } = await seeded();
    const off = await run(repo, T_NOW, { noJev: true, cache: false });
    const on = await run(repo, T_NOW, { noJev: true });
    expect(on.result.chunks.map((s) => s.chunk.id)).toEqual(off.result.chunks.map((s) => s.chunk.id));
    expect(JSON.stringify(on.result)).not.toContain("memory:");
  });
});

describe("unverified documents", () => {
  test("a tampered feedback document is ignored with one warning in the run", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    const runId = first.result.runId!;
    await give(repo, { runId, missing: ["frobnicateGadgets"] });
    const store = join(repo, ".scope/store-v1");
    const name = (await readdir(store)).find((file) => file.startsWith("feedback-"))!;
    const document = JSON.parse(await readFile(join(store, name), "utf8"));
    document.mac = "0".repeat(document.mac.length);
    await writeFile(join(store, name), JSON.stringify(document));

    const { result } = await run(repo, T_NOW);
    expect(result.warnings.filter((warning) => warning.includes(name))).toHaveLength(1);
    expect(find(result, "frobnicateGadgets")).toBeUndefined();
  });
});

describe("decision reuse", () => {
  test("an identical repeated task still reuses the decision", async () => {
    const repo = await makeRepo();
    await seed(repo, T_FROB, { frobnicateWidgets: 0.9, frobnicateGadgets: 0.9 });
    // Two memory candidates, of which Jev selects only one.
    const rec = recording({ reconcileLedger: 0.9, frobnicateGadgets: 0.9, frobnicateWidgets: 0.05 });
    const first = await run(repo, T_NOW, { rec });
    expect(rec.names(0)).toEqual(["reconcileLedger", "frobnicateWidgets", "frobnicateGadgets"]);
    expect(first.result.chunks.map((s) => s.chunk.name)).toContain("frobnicateGadgets");
    const second = await run(repo, T_NOW, { rec });
    // The first run of this task is not offered again, so the payload, its key and the stored decision are the same.
    expect(rec.calls.length).toBe(1);
    expect(second.result.chunks.map((s) => s.chunk.id)).toEqual(first.result.chunks.map((s) => s.chunk.id));
  });

  test("two long tasks that share their stored prefix are related, not the same task", async () => {
    const repo = await makeRepo();
    // History keeps only the first MAX_TASK_CHARS characters, which these two tasks share.
    const prefix = "nightly batch job ".repeat(Math.ceil(MAX_TASK_CHARS / 18));
    const first = await seed(repo, `${prefix} frobnicate widgets`);
    expect(first.result.chunks.map((s) => s.chunk.name)).toContain("frobnicateWidgets");
    const { result, rec } = await run(repo, `${prefix} reconcile ledger`);
    expect(rec.names()).toContain("frobnicateWidgets");
    expect(find(result, "frobnicateWidgets")!.origin).toBe(`memory: similar task ${first.result.runId!}`);
  });

  test("at the maxRuns boundary, a repeat's own run does not push out the related run that shaped it", async () => {
    const repo = await makeRepo();
    await seed(repo, T_WIDGETS);
    const rec = recording(SEED_RELEVANCE);
    const memory = { maxRuns: 1 };
    await run(repo, T_NOW, { rec, memory });
    expect(rec.names(0)).toEqual(["reconcileLedger", "frobnicateWidgets"]);
    await run(repo, T_NOW, { rec, memory });
    expect(rec.calls.length).toBe(1);
  });
});

describe("payload preview", () => {
  const storeFiles = async (repo: string) => (await readdir(join(repo, ".scope"), { recursive: true })).sort();
  const preview = (repo: string, env: NodeJS.ProcessEnv) =>
    previewJevPayload({ task: T_NOW, repo, cache: true, retrieval: SHORTLIST, cacheOptions: { env } });

  test("matches what a run sends, deterministically, and writes nothing", async () => {
    const repo = await makeRepo();
    const first = await seed(repo, T_WIDGETS);
    await give(repo, { runId: first.result.runId!, missing: ["frobnicateGadgets"] });
    const before = await storeFiles(repo);

    const shown = await preview(repo, {});
    expect(await preview(repo, {})).toEqual(shown);
    expect(await storeFiles(repo)).toEqual(before);
    expect((await preview(repo, NO_MEMORY)).candidateCount).toBe(1);

    const { rec } = await run(repo, T_NOW);
    expect(rec.names()).toEqual(["reconcileLedger", "frobnicateGadgets", "frobnicateWidgets"]);
    expect(shown.candidateCount).toBe(3);
    expect(shown.requests).toEqual(planJevRequests(T_NOW, rec.calls[0]!));
  });
});

describe("payload preview without a key", () => {
  test("creates no integrity key, state directory or cache, and sends the memory-free payload", async () => {
    const repo = await makeRepo();
    const state = join(tmp, "empty-state");
    await mkdir(state);
    const shown = await previewJevPayload({
      task: T_NOW,
      repo,
      cache: true,
      retrieval: SHORTLIST,
      cacheOptions: { env: {}, integrityEnv: { XDG_STATE_HOME: state } },
    });
    expect(await readdir(state)).toEqual([]);
    expect(await readdir(repo)).not.toContain(".scope");
    expect(shown.candidateCount).toBe(1);
  });
});

describe("similarity", () => {
  const set = (...terms: string[]) => new Set(terms);
  test("is Jaccard over the term sets", () => {
    expect(similarity(set("a", "b", "c"), set("b", "c", "d"))).toBe(0.5);
    expect(similarity(set("a"), set("a"))).toBe(1);
    expect(similarity(set("a"), set("b"))).toBe(0);
  });
  test("two empty sets are not similar", () => {
    expect(similarity(set(), set())).toBe(0);
  });
});

describe("addMemoryCandidates", () => {
  test("with no history it returns the fresh shortlist as it was", () => {
    const outcome = addMemoryCandidates({
      task: T_NOW,
      chunks: [],
      files: new Set(),
      fresh: { candidates: [], ranking: new Map() },
      history: [],
      feedback: [],
      config: { maxCandidates: 5, similarityMin: 0.3, maxRuns: 20 },
    });
    expect(outcome.candidates).toEqual([]);
    expect(outcome.added).toEqual([]);
  });
});
