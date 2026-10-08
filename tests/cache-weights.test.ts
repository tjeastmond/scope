import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetWeights } from "../src/cache/controls.ts";
import { readFeedback } from "../src/cache/feedback.ts";
import { readHistory } from "../src/cache/history.ts";
import { openRepositoryCache, type RepositoryCache } from "../src/cache/location.ts";
import {
  ADAPTIVE_BOUND,
  IDENTITY_MULTIPLIERS,
  SIGNAL_NAMES,
  WEIGHTS_DOCUMENT,
  adaptiveVersion,
  applyMultipliers,
  evaluateProposal,
  judgePromotion,
  promoteWeights,
  proposeWeights,
  readActiveWeights,
  weightsMac,
  type Evaluation,
  type Multipliers,
  type WeightsRecord,
} from "../src/cache/weights.ts";
import { submitFeedback, type FeedbackInput } from "../src/feedback.ts";
import { planJevRequests } from "../src/jev/provider.ts";
import { main, type Io } from "../src/main.ts";
import { renderFormat } from "../src/output/index.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/retrieval/config.ts";
import { loadChunks, previewJevPayload, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { runAdaptation } from "../scripts/adapt-weights.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { loadLabeledTasks } from "./helpers/labels.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const BASELINE = DEFAULT_RETRIEVAL_CONFIG.version;
/** Changes which of the mixed-app chunks the first task shortlists and in what order. */
const REORDER: Multipliers = { symbol: 0.8, lexical: 1.2, path: 1.2, dependency: 0.8, test: 1, proximity: 1 };
/** Scales every weight alike, so rankings are identical and only the version differs. */
const UNIFORM: Multipliers = { symbol: 1.1, lexical: 1.1, path: 1.1, dependency: 1.1, test: 1.1, proximity: 1.1 };
const PASSING: Evaluation = { tasks: 3, baseline: { found: 4, total: 9 }, proposal: { found: 5, total: 9 } };
const TASK = "Show each invoice's due date in the invoice list: render it in the frontend row.";

let tmp: string;
let clock = 0;
const now = () => (clock += 1000);
const saved: Record<string, string | undefined> = {};
const ENV_NAMES = ["SCOPE_CACHE", "SCOPE_MEMORY", "SCOPE_ADAPTIVE", "TYPESAFE_API_KEY"];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-weights-"));
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
async function mixedCopy(): Promise<string> {
  const repo = join(tmp, `mixed-${repos++}`);
  await cp(join(FIXTURES, "mixed-app"), repo, { recursive: true });
  return repo;
}
const fn = (name: string, body: string) => `export function ${name}(x: number) {\n  return ${body};\n}\n`;
/** Small repo for proposals: one chunk the task names, the rest filler. */
async function smallRepo(): Promise<string> {
  const repo = join(tmp, `small-${repos++}`);
  await mkdir(join(repo, "src/ledger"), { recursive: true });
  await mkdir(join(repo, "src/misc"), { recursive: true });
  await writeFile(join(repo, "src/ledger/reconcile.ts"), fn("reconcileLedger", "x + 1"));
  for (let i = 0; i < 6; i++) await writeFile(join(repo, `src/misc/filler${i}.ts`), fn(`filler${i}Thing`, `x + ${i}`));
  return repo;
}

function recording() {
  const inner = fakeProvider({ relevance: { reconcileLedger: 0.9 }, fallback: 0.5 });
  const calls: CodeChunk[][] = [];
  const provider: DecisionProvider = {
    decisionCacheKey: inner.decisionCacheKey,
    async decide(input) {
      calls.push([...input.candidates]);
      return inner.decide(input);
    },
  };
  return { provider, calls };
}

async function run(
  repo: string,
  task = TASK,
  options: { env?: NodeJS.ProcessEnv; noJev?: boolean; fresh?: boolean } = {},
) {
  const rec = recording();
  const { result } = await runScope({
    task,
    repo,
    provider: rec.provider,
    noJev: options.noJev,
    cache: true,
    reuseDecisions: !options.fresh,
    explain: true,
    cacheOptions: { now, env: options.env ?? {} },
  });
  const shortlist = rec.calls[0]?.map((chunk) => chunk.id) ?? [];
  return { result, rec, shortlist, json: JSON.parse(renderFormat("json", result)) as Record<string, unknown> };
}

/** The JSON of a run without what legitimately differs between runs. */
const scrub = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      ["runId", "decisionsReusedFrom", "jev", "cache"].includes(key) ? undefined : item,
    ),
  );

async function open(repo: string): Promise<RepositoryCache> {
  const { cache } = await openRepositoryCache(repo);
  return cache!;
}
async function promote(repo: string, multipliers = REORDER, evaluation = PASSING) {
  const outcome = await promoteWeights(await open(repo), multipliers, evaluation, { now: now() });
  if (!outcome.promoted) throw new Error(outcome.reason);
  return outcome.record;
}
const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const documentPath = (repo: string) => join(storeDir(repo), `${WEIGHTS_DOCUMENT}.json`);
const hasDocument = async (repo: string) => (await readdir(storeDir(repo))).includes(`${WEIGHTS_DOCUMENT}.json`);
async function snapshot(repo: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(storeDir(repo))).sort()) {
    out[name] = await readFile(join(storeDir(repo), name), "utf8").catch(() => "");
  }
  return out;
}
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}
async function cli(...argv: string[]) {
  const c = capture();
  const code = await main(argv, c.io);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

describe("the held-out gate", () => {
  const refused: [string, Multipliers, Evaluation, RegExp][] = [
    [
      "equal recall",
      REORDER,
      { tasks: 3, baseline: { found: 4, total: 9 }, proposal: { found: 4, total: 9 } },
      /does not beat/,
    ],
    [
      "lower recall",
      REORDER,
      { tasks: 3, baseline: { found: 4, total: 9 }, proposal: { found: 3, total: 9 } },
      /does not beat/,
    ],
    [
      "zero tasks",
      REORDER,
      { tasks: 0, baseline: { found: 0, total: 0 }, proposal: { found: 0, total: 0 } },
      /no held-out tasks/,
    ],
    [
      "tasks without labels",
      REORDER,
      { tasks: 2, baseline: { found: 0, total: 0 }, proposal: { found: 0, total: 0 } },
      /no held-out tasks/,
    ],
    [
      "zero tasks with a better count",
      REORDER,
      { tasks: 0, baseline: { found: 1, total: 9 }, proposal: { found: 5, total: 9 } },
      /no held-out tasks/,
    ],
    [
      "different label totals",
      REORDER,
      { tasks: 3, baseline: { found: 1, total: 9 }, proposal: { found: 5, total: 10 } },
      /different labels/,
    ],
    ["the identity", { ...IDENTITY_MULTIPLIERS }, PASSING, /no change/],
  ];
  for (const [name, multipliers, evaluation, reason] of refused) {
    test(`${name} writes nothing, says why, and runs keep the baseline`, async () => {
      const repo = await mixedCopy();
      const before = await run(repo, TASK, { fresh: true });
      const files = await snapshot(repo);
      const outcome = await promoteWeights(await open(repo), multipliers, evaluation, { now: now() });
      expect(outcome.promoted).toBe(false);
      expect(!outcome.promoted && outcome.reason).toMatch(reason);
      expect(await hasDocument(repo)).toBe(false);
      expect(await snapshot(repo)).toEqual(files);
      const after = await run(repo, TASK, { fresh: true });
      expect(after.json.retrievalConfigVersion).toBe(BASELINE);
      expect(after.shortlist).toEqual(before.shortlist);
    });
  }

  test("strictly better held-out recall promotes a signed, bounded document of numbers only", async () => {
    const repo = await mixedCopy();
    const record = await promote(repo);
    expect(record.version).toBe(adaptiveVersion(BASELINE, REORDER));
    expect(record.version).toMatch(/^adaptive-[0-9a-f]{12}$/);
    const text = await readFile(documentPath(repo), "utf8");
    expect(JSON.parse(text).record).toEqual(record);
    expect(Object.keys(record).sort()).toEqual(
      ["baselineVersion", "evaluation", "multipliers", "promotedAt", "recordVersion", "version"].sort(),
    );
    const read = await readActiveWeights(await open(repo));
    expect(read.record).toEqual(record);
    expect(read.warnings).toEqual([]);
  });

  test("judgePromotion rejects out-of-bound multipliers", () => {
    for (const bad of [1.2000001, 0.79, Number.NaN, Infinity]) {
      expect(judgePromotion({ ...REORDER, symbol: bad }, PASSING).promote).toBe(false);
    }
    expect(judgePromotion({ ...REORDER, symbol: 1.2, lexical: 0.8 }, PASSING).promote).toBe(true);
  });

  test("evaluateProposal runs the evaluator on the baseline and on the adapted config", async () => {
    const seen: [string, number][] = [];
    const evaluation = await evaluateProposal(REORDER, (config) => {
      seen.push([config.version, config.weights.symbol]);
      return config.version === BASELINE ? { tasks: 2, found: 1, total: 4 } : { tasks: 2, found: 3, total: 4 };
    });
    expect(seen[0]).toEqual([BASELINE, DEFAULT_RETRIEVAL_CONFIG.weights.symbol]);
    expect(seen[1]![0]).toBe(`${BASELINE}+${adaptiveVersion(BASELINE, REORDER)}`);
    expect(seen[1]![1]).toBeCloseTo(DEFAULT_RETRIEVAL_CONFIG.weights.symbol * 0.8, 12);
    expect(evaluation).toEqual({ tasks: 2, baseline: { found: 1, total: 4 }, proposal: { found: 3, total: 4 } });
  });
});

describe("runtime effect and rollback", () => {
  test("a promoted set changes the shortlist; reset-weights restores the baseline run exactly", async () => {
    const repo = await mixedCopy();
    const first = await run(repo, TASK, { fresh: true });
    expect(first.json.retrievalConfigVersion).toBe(BASELINE);

    const record = await promote(repo);
    const adapted = await run(repo, TASK, { fresh: true });
    expect(adapted.json.retrievalConfigVersion).toBe(`${BASELINE}+${record.version}`);
    expect(adapted.shortlist).not.toEqual(first.shortlist);
    expect(scrub(adapted.json)).not.toEqual(scrub(first.json));

    const reset = await cli("cache", "reset-weights", "--repo", repo);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Removed the adaptive retrieval weights");
    expect(await hasDocument(repo)).toBe(false);

    const again = await run(repo, TASK, { fresh: true });
    expect(again.shortlist).toEqual(first.shortlist);
    expect(scrub(again.json)).toEqual(scrub(first.json));
    expect(renderFormat("text", again.result).replace(/^(Run |cache:|Cache ).*\n/gm, "")).toEqual(
      renderFormat("text", first.result).replace(/^(Run |cache:|Cache ).*\n/gm, ""),
    );
  });

  test("a set promoted for another baseline version is not applied to a run with a different config", async () => {
    const repo = await mixedCopy();
    const first = await run(repo, TASK, { fresh: true });
    await promote(repo);
    const rec = recording();
    const { result } = await runScope({
      task: TASK,
      repo,
      provider: rec.provider,
      cache: true,
      reuseDecisions: false,
      retrieval: { version: "other-baseline" },
      cacheOptions: { now, env: {} },
    });
    const json = JSON.parse(renderFormat("json", result)) as Record<string, unknown>;
    expect(json.retrievalConfigVersion).toBe("other-baseline");
    expect(rec.calls[0]!.map((chunk) => chunk.id)).toEqual(first.shortlist);
  });

  test("reset-weights leaves analysis, history, feedback and decisions alone", async () => {
    const repo = await mixedCopy();
    const { result } = await run(repo, TASK);
    await submitFeedback(
      { runId: result.runId!, useful: [result.chunks[0]!.chunk.id], irrelevant: [], missing: [] },
      { repo, env: {}, cacheOptions: { now } },
    );
    await promote(repo);
    const before = await snapshot(repo);
    expect(Object.keys(before).some((name) => name.startsWith("history-"))).toBe(true);
    expect(Object.keys(before).some((name) => name.startsWith("feedback-"))).toBe(true);
    expect(Object.keys(before).some((name) => name.startsWith("decision-"))).toBe(true);
    expect(await resetWeights(repo)).toEqual({ removed: true });
    const rest = { ...before };
    delete rest[`${WEIGHTS_DOCUMENT}.json`];
    expect(await snapshot(repo)).toEqual(rest);
  });

  test("reset-weights with nothing active says so and exits 0, creating nothing", async () => {
    const repo = await mixedCopy();
    const none = await cli("cache", "reset-weights", "--repo", repo);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("No adaptive retrieval weights were active");
    expect(await readdir(repo)).not.toContain(".scope");

    await run(repo);
    const files = await snapshot(repo);
    const warm = await cli("cache", "reset-weights", "--repo", repo);
    expect(warm.code).toBe(0);
    expect(warm.stdout).toContain("No adaptive retrieval weights were active");
    expect(await snapshot(repo)).toEqual(files);
  });

  test("SCOPE_ADAPTIVE=off and --no-jev use the baseline even with a promoted set", async () => {
    const repo = await mixedCopy();
    const base = await run(repo, TASK, { fresh: true });
    await promote(repo);
    const on = await run(repo, TASK, { fresh: true });
    expect(on.shortlist).not.toEqual(base.shortlist);

    const off = await run(repo, TASK, { fresh: true, env: { SCOPE_ADAPTIVE: "off" } });
    expect(off.json.retrievalConfigVersion).toBe(BASELINE);
    expect(off.shortlist).toEqual(base.shortlist);
    expect(scrub(off.json)).toEqual(scrub(base.json));

    const noJev = await run(repo, TASK, { noJev: true });
    expect(noJev.json.retrievalConfigVersion).toBe(BASELINE);
    const noJevBaseline = await run(await mixedCopy(), TASK, { noJev: true });
    expect(scrub(noJev.json)).toEqual(scrub(noJevBaseline.json));

    // Any other value leaves it on.
    const other = await run(repo, TASK, { fresh: true, env: { SCOPE_ADAPTIVE: "on" } });
    expect(other.shortlist).toEqual(on.shortlist);
  });

  test("the adapted version is recorded in history and is part of the decision key", async () => {
    const repo = await mixedCopy();
    const baseline = await run(repo, TASK);
    expect(baseline.json.decisionsReusedFrom ?? baseline.result.decisionsReusedFrom).toBeUndefined();
    const record = await promote(repo, UNIFORM);

    // Uniform scaling keeps every ranking, so only the version can make the decision differ.
    const adapted = await run(repo, TASK);
    expect(adapted.shortlist).toEqual(baseline.shortlist);
    expect(adapted.result.decisionsReusedFrom).toBeUndefined();
    const history = await readHistory(await open(repo));
    const versions = history.records.map((item) => item.config.retrievalConfigVersion).sort();
    expect(versions).toEqual([BASELINE, `${BASELINE}+${record.version}`].sort());

    // The same adapted run is then reused, and the baseline run's decision is reused again with the set switched off.
    const repeat = await run(repo, TASK);
    expect(repeat.result.decisionsReusedFrom).toBeDefined();
    const off = await run(repo, TASK, { env: { SCOPE_ADAPTIVE: "off" } });
    expect(off.result.decisionsReusedFrom).toBeDefined();
    expect(off.json.retrievalConfigVersion).toBe(BASELINE);
  });

  test("previewJevPayload matches the payload of a run with an active set", async () => {
    const repo = await mixedCopy();
    await run(repo);
    await promote(repo);
    const live = await run(repo, TASK, { fresh: true });
    const preview = await previewJevPayload({ task: TASK, repo, cache: true, cacheOptions: { env: {} } });
    expect(preview.requests).toEqual(planJevRequests(TASK, live.rec.calls[0]!));
    const baseline = await previewJevPayload({
      task: TASK,
      repo,
      cache: true,
      cacheOptions: { env: { SCOPE_ADAPTIVE: "off" } },
    });
    expect(baseline.requests).not.toEqual(preview.requests);
  });
});

describe("documents that are not trusted", () => {
  const signed = async (repo: string, patch: Partial<WeightsRecord> & { multipliers?: Multipliers }) => {
    const cache = await open(repo);
    const multipliers = patch.multipliers ?? REORDER;
    const baselineVersion = patch.baselineVersion ?? BASELINE;
    const record: WeightsRecord = {
      recordVersion: 1,
      version: adaptiveVersion(baselineVersion, multipliers),
      baselineVersion,
      multipliers,
      promotedAt: 1,
      evaluation: PASSING,
    };
    await writeFile(documentPath(repo), JSON.stringify({ schemaVersion: 1, record, mac: weightsMac(cache, record) }));
  };
  const cases: [string, (repo: string) => Promise<void>][] = [
    [
      "an out-of-bound multiplier (correctly signed)",
      (repo) => signed(repo, { multipliers: { ...REORDER, symbol: 1.5 } }),
    ],
    [
      "a multiplier just over the bound",
      (repo) => signed(repo, { multipliers: { ...REORDER, path: 1 + ADAPTIVE_BOUND + 1e-9 } }),
    ],
    ["another baseline version (correctly signed)", (repo) => signed(repo, { baselineVersion: "retrieval-v3" })],
    [
      "a wrong signature",
      async (repo) => {
        await promote(repo);
        const parsed = JSON.parse(await readFile(documentPath(repo), "utf8"));
        parsed.mac = (parsed.mac[0] === "0" ? "1" : "0") + parsed.mac.slice(1);
        await writeFile(documentPath(repo), JSON.stringify(parsed));
      },
    ],
    [
      "a tampered multiplier",
      async (repo) => {
        await promote(repo);
        const parsed = JSON.parse(await readFile(documentPath(repo), "utf8"));
        parsed.record.multipliers.symbol = 1.2;
        parsed.record.version = adaptiveVersion(BASELINE, parsed.record.multipliers);
        await writeFile(documentPath(repo), JSON.stringify(parsed));
      },
    ],
    ["a malformed document", (repo) => writeFile(documentPath(repo), "{ not json")],
    [
      "a document of the wrong shape",
      (repo) => writeFile(documentPath(repo), JSON.stringify({ schemaVersion: 1, record: {}, mac: "x" })),
    ],
  ];
  for (const [name, plant] of cases) {
    test(`${name} is ignored with exactly one warning`, async () => {
      const repo = await mixedCopy();
      const base = await run(repo, TASK, { fresh: true });
      await plant(repo);
      const after = await run(repo, TASK, { fresh: true });
      expect(after.json.retrievalConfigVersion).toBe(BASELINE);
      expect(after.shortlist).toEqual(base.shortlist);
      expect(after.result.warnings.filter((warning) => warning.includes(WEIGHTS_DOCUMENT))).toHaveLength(1);
      const preview = await previewJevPayload({ task: TASK, repo, cache: true, cacheOptions: { env: {} } });
      expect(preview.requests).toEqual(planJevRequests(TASK, base.rec.calls[0]!));
      // The next promotion replaces it, and the reset removes whatever is there.
      expect(await resetWeights(repo)).toEqual({ removed: true });
    });
  }

  test("an absent document adds no warning", async () => {
    const repo = await mixedCopy();
    const { result } = await run(repo);
    expect(result.warnings.filter((warning) => warning.includes(WEIGHTS_DOCUMENT))).toEqual([]);
  });

  test("a set copied from another repository does not verify", async () => {
    const one = await mixedCopy();
    const two = await mixedCopy();
    await run(one);
    await run(two);
    await promote(one);
    await cp(documentPath(one), documentPath(two));
    const read = await readActiveWeights(await open(two));
    expect(read.record).toBeUndefined();
    expect(read.warnings).toHaveLength(1);
  });

  test("applyMultipliers scales the baseline weights and names the set", () => {
    const record = { version: "adaptive-abc", multipliers: REORDER } as WeightsRecord;
    const config = applyMultipliers(DEFAULT_RETRIEVAL_CONFIG as never, record);
    expect(config.version).toBe(`${BASELINE}+adaptive-abc`);
    for (const name of SIGNAL_NAMES) {
      expect(config.weights[name]).toBeCloseTo(DEFAULT_RETRIEVAL_CONFIG.weights[name] * REORDER[name], 12);
    }
    expect(DEFAULT_RETRIEVAL_CONFIG.weights.symbol).toBe(0.3);
  });
});

describe("proposals", () => {
  const FEEDBACK_TASK = "nightly batch job reconcile ledger";
  async function seeded(options: { feedback?: Partial<FeedbackInput>; agent?: boolean } = {}) {
    const repo = await smallRepo();
    const { result } = await run(repo, FEEDBACK_TASK);
    if (options.feedback) {
      const ledger = result.chunks.find((s) => s.chunk.name === "reconcileLedger")!.chunk.id;
      await submitFeedback(
        { runId: result.runId!, useful: [ledger], irrelevant: [], missing: [], ...options.feedback },
        { repo, env: {}, cacheOptions: { now } },
      );
    }
    const cache = await open(repo);
    const { chunks } = await loadChunks(repo);
    const history = (await readHistory(cache)).records;
    const feedback = (await readFeedback(cache)).records;
    return { repo, cache, chunks, history, feedback, result };
  }

  test("no feedback gives the identity, even with Jev scores and selections in the history", async () => {
    const { history, feedback, chunks } = await seeded();
    expect(history).toHaveLength(1);
    expect(history[0]!.candidates.some((c) => c.decision === "selected" && (c.relevance ?? 0) > 0.8)).toBe(true);
    const proposal = proposeWeights({ history, feedback, chunks });
    expect(proposal.identity).toBe(true);
    expect(proposal.multipliers).toEqual(IDENTITY_MULTIPLIERS);
  });

  test("useful feedback on a chunk with a strong signal raises that signal's multiplier", async () => {
    const { history, feedback, chunks } = await seeded({ feedback: {} });
    const proposal = proposeWeights({ history, feedback, chunks });
    expect(proposal.identity).toBe(false);
    expect(proposal.multipliers.symbol).toBeGreaterThan(1);
    expect(proposal.multipliers.symbol).toBeLessThanOrEqual(1 + ADAPTIVE_BOUND);
    expect(proposal.samples.runs).toBe(1);
    expect(proposal.samples.useful).toBe(1);
  });

  test("irrelevant-only feedback teaches nothing", async () => {
    const { repo, result } = await seeded();
    const ledger = result.chunks.find((s) => s.chunk.name === "reconcileLedger")!.chunk.id;
    await submitFeedback(
      { runId: result.runId!, useful: [], irrelevant: [ledger], missing: [] },
      { repo, env: {}, cacheOptions: { now } },
    );
    const cache = await open(repo);
    const { chunks: current } = await loadChunks(repo);
    const proposal = proposeWeights({
      history: (await readHistory(cache)).records,
      feedback: (await readFeedback(cache)).records,
      chunks: current,
    });
    // Irrelevant only: nothing confirmed useful to compare with, so nothing is learned.
    expect(proposal.identity).toBe(true);
  });

  test("every multiplier stays within the bound and the proposal is deterministic in input order", async () => {
    const { history, feedback, chunks } = await seeded({ feedback: {} });
    const proposal = proposeWeights({ history, feedback, chunks });
    for (const name of SIGNAL_NAMES) {
      expect(Number.isFinite(proposal.multipliers[name])).toBe(true);
      expect(proposal.multipliers[name]).toBeGreaterThanOrEqual(1 - ADAPTIVE_BOUND);
      expect(proposal.multipliers[name]).toBeLessThanOrEqual(1 + ADAPTIVE_BOUND);
    }
    const reversed = proposeWeights({
      history: [...history].reverse(),
      feedback: [...feedback].reverse(),
      chunks: [...chunks].reverse(),
    });
    expect(reversed).toEqual(proposal);
    expect(proposeWeights({ history, feedback, chunks })).toEqual(proposal);
  });

  test("feedback about changed code teaches nothing", async () => {
    const { repo, history, feedback } = await seeded({ feedback: {} });
    await writeFile(join(repo, "src/ledger/reconcile.ts"), fn("reconcileLedger", "x + 99"));
    const { chunks } = await loadChunks(repo);
    expect(proposeWeights({ history, feedback, chunks }).identity).toBe(true);
  });
});

describe("the evaluation harness", () => {
  test("a refused evaluation writes no history, feedback or decision documents", async () => {
    const repo = await mixedCopy();
    const heldout = (await loadLabeledTasks("mixed-app")).filter((task) => task.split === "heldout");
    expect(heldout.length).toBeGreaterThan(0);
    await run(repo, "Show every invoice amount");
    const before = await snapshot(repo);

    const dry = await runAdaptation({ repo, fixture: "mixed-app" });
    expect(dry.identity).toBe(true);
    expect(dry.evaluation.tasks).toBe(heldout.length);
    expect(dry.outcome.promoted).toBe(false);
    const promoting = await runAdaptation({ repo, fixture: "mixed-app", promote: true });
    expect(promoting.outcome.promoted).toBe(false);
    expect(await snapshot(repo)).toEqual(before);

    const stored = Object.values(await snapshot(repo)).join("\n");
    for (const task of heldout) {
      expect(stored).not.toContain(task.task);
      for (const label of task.required) expect(stored).not.toContain(label);
    }
  });

  test("runs of a held-out task and their feedback are left out of the proposal", async () => {
    const repo = await mixedCopy();
    const heldout = (await loadLabeledTasks("mixed-app")).find((task) => task.split === "heldout")!;
    const { result } = await run(repo, `  ${heldout.task.toUpperCase()}  `);
    await submitFeedback(
      { runId: result.runId!, useful: [result.chunks[0]!.chunk.id], irrelevant: [], missing: [] },
      { repo, env: {}, cacheOptions: { now } },
    );
    const report = await runAdaptation({ repo, fixture: "mixed-app" });
    expect(report.excludedHeldoutRuns).toBe(1);
    expect(report.identity).toBe(true);
    expect(report.samples.runs).toBe(0);
  });

  test("the script prints both recall numbers and the multipliers, and refuses an identity", async () => {
    const repo = await mixedCopy();
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "../scripts/adapt-weights.ts"), repo, "--fixture", "mixed-app"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(output).toMatch(/baseline recall: \d+\/\d+/);
    expect(output).toMatch(/proposal recall: \d+\/\d+/);
    expect(output).toContain("multipliers: symbol 1, lexical 1");
    expect(output).toContain("the gate refuses: no change");
    await expect(readdir(join(repo, ".scope"))).rejects.toThrow();
  });
});

describe("status and clear", () => {
  test("status shows the active version, or baseline", async () => {
    const repo = await mixedCopy();
    await run(repo);
    expect((await cli("cache", "status", "--repo", repo)).stdout).toMatch(/weights:\s+baseline/);
    const record = await promote(repo);
    const status = await cli("cache", "status", "--repo", repo);
    expect(status.stdout).toContain(record.version);
    expect(status.stdout).toContain("held-out recall 5/9");
    const json = JSON.parse((await cli("cache", "status", "--repo", repo, "--format", "json")).stdout);
    expect(json.weights.version).toBe(record.version);
    await resetWeights(repo);
    expect((await cli("cache", "status", "--repo", repo)).stdout).toMatch(/weights:\s+baseline/);
  });

  test("clear removes the document too", async () => {
    const repo = await mixedCopy();
    await run(repo);
    await promote(repo);
    expect(await hasDocument(repo)).toBe(true);
    const cleared = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(cleared.code).toBe(0);
    await expect(readdir(storeDir(repo))).rejects.toThrow();
  });

  test("the help lists reset-weights and SCOPE_ADAPTIVE", async () => {
    const help = await cli("cache", "--help");
    expect(help.stdout).toContain("reset-weights");
    expect(help.stdout).toContain("SCOPE_ADAPTIVE=off");
    expect((await cli("--help")).stdout).toContain("scope cache reset-weights");
  });
});
