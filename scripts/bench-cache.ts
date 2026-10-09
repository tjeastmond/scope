// M6 benchmark (#82): what the persistent cache and retrieval memory actually buy. Dev script, never shipped.
//
// Usage: bun scripts/bench-cache.ts [--live] [--repeats N] [--out docs/evaluations/m6-runs.json]
//
// Scenarios (each repeated `--repeats` times, default 3, on fresh copies of the repository):
//   1. cold vs warm parse        loadChunks with no .scope/, with the cache filled, and after editing one file.
//   2. repeated identical task   the same task twice with the cache on: Jev requests and latency of the second run.
//   3. related task              a hand-written paraphrase after the original task and its feedback, memory on and off.
//   4. unseen task               each task with and without history from other tasks, memory on and off.
//   5. adaptive weights          the #78 held-out gate, run once on the feedback gathered in scenario 3.
//
// Provider. Offline (default): a deterministic stand-in for Jev built from the task's labels (required and useful
// 0.9, irrelevant 0.05, everything else 0.1), so the run needs no network and its recall numbers repeat exactly; its
// token counts are fake and are not reported as Jev usage. `--live`: the real Jev provider, for Jev's own reported
// usage and latency. The SDK reads the API key from TYPESAFE_API_KEY in the environment; this script only checks that
// it is set and never prints, logs or writes it.
//
// Isolation. Every run works on a mkdtemp copy of a fixture (or of this repository's src/) under a temporary
// XDG_STATE_HOME, so no real cache or integrity key is touched; the copies are removed at the end.
//
// Label isolation. Feedback is submitted only for `tuning` tasks (`submitTuningFeedback` refuses anything else), and
// histories used to measure other tasks never contain a held-out run. A held-out task is only ever run in its own
// measurement. No token counts are estimated anywhere; only what a provider reported is shown.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { submitFeedback } from "../src/feedback.ts";
import { planJevRequests, JevDecisionProvider } from "../src/jev/provider.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider, DecisionRequest, DecisionResult, ScopeResult } from "../src/types.ts";
import { FIXTURES, TASKS, loadLabeledTasks, resolve, type LabeledTask } from "../tests/helpers/labels.ts";
import { runAdaptation, type AdaptationReport } from "./adapt-weights.ts";
import { labelRecall } from "./recall-lib.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * Hand-written paraphrases of the tuning tasks: worded differently, needing the same code. A paraphrase keeps the
 * labels of the task it rewords. Held-out tasks have none, by design.
 */
export const PARAPHRASES: Readonly<Record<string, string>> = {
  "due-date-column":
    "Each row of the invoice list should display when the invoice is due; the backend already sends dueDate, so only " +
    "the frontend row component needs to render it.",
  "configurable-reminder-retries":
    "Stop hard-coding the retry attempts and backoff delays in the reminder worker: read them from the reminders " +
    "section of config/app.toml and document the new setting.",
};

// ---------------------------------------------------------------- context

export interface BenchContext {
  live: boolean;
  repeats: number;
  tmpRoot: string;
  integrityEnv: NodeJS.ProcessEnv;
  /** Every feedback submission, so a test (and the report) can show that only tuning tasks ever had any. */
  feedbackLog: { fixture: string; task: string; split: LabeledTask["split"] }[];
  counters: ProviderCounter[];
  dispose(): Promise<void>;
}

export interface ProviderCounter {
  provider: DecisionProvider;
  /** Calls to `decide`, i.e. Jev decisions actually requested. */
  calls: number;
  /** Ids of every candidate passed to `decide` (the shortlist Jev was shown), in order; empty on a decision-cache hit. */
  candidates: string[];
}

export async function createContext(options: { live?: boolean; repeats?: number } = {}): Promise<BenchContext> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "scope-bench-"));
  const stateHome = join(tmpRoot, "state");
  await mkdir(stateHome, { recursive: true });
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  return {
    live: options.live ?? false,
    repeats: options.repeats ?? 3,
    tmpRoot,
    integrityEnv: { XDG_STATE_HOME: stateHome },
    feedbackLog: [],
    counters: [],
    async dispose() {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

let workspaceCounter = 0;

/** A fresh copy of `source` (timestamps preserved, so files look as old as in a checkout) with no `.scope/`. */
async function workspace(ctx: BenchContext, source: string, subdir = ""): Promise<string> {
  const root = join(ctx.tmpRoot, `ws${workspaceCounter++}`);
  const dest = subdir ? join(root, subdir) : root;
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) => !/(^|\/)\.scope(\/|$)/.test(path),
  });
  return root;
}

const fixtureDir = (fixture: string) => join(FIXTURES, fixture);

// ---------------------------------------------------------------- providers

/** A deterministic stand-in for Jev driven by the task's labels, keyed by chunk id. */
function labelProvider(task: LabeledTask, chunks: readonly CodeChunk[]): DecisionProvider {
  const score = new Map<string, number>();
  for (const [labels, value] of [
    [task.irrelevant, 0.05],
    [task.useful, 0.9],
    [task.required, 0.9],
  ] as const) {
    for (const label of labels) for (const chunk of resolve(label, chunks)) score.set(chunk.id, value);
  }
  return {
    // A distinct identity from the real adapter, so these judgments are never reused as Jev's.
    decisionCacheKey: (taskText, candidates) => ({
      provider: "bench-labels",
      payload: planJevRequests(taskText, candidates),
    }),
    async decide({ candidates }: DecisionRequest): Promise<DecisionResult> {
      return {
        judgments: candidates.map((chunk) => ({ chunkId: chunk.id, relevance: score.get(chunk.id) ?? 0.1 })),
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
        requests: [{ latencyMs: 0, inputTokens: 0, outputTokens: 0 }],
      };
    },
  };
}

/** The provider for `task` (labels are only read by the offline stand-in), wrapped to count its calls. */
export function countingProvider(ctx: BenchContext, task: LabeledTask, chunks: readonly CodeChunk[]): ProviderCounter {
  const inner = ctx.live ? new JevDecisionProvider() : labelProvider(task, chunks);
  const counter: ProviderCounter = {
    calls: 0,
    candidates: [],
    provider: {
      decisionCacheKey: (taskText, candidates) => inner.decisionCacheKey?.(taskText, candidates),
      async decide(request) {
        counter.calls++;
        counter.candidates.push(...request.candidates.map((chunk) => chunk.id));
        return inner.decide(request);
      },
    },
  };
  ctx.counters.push(counter);
  return counter;
}

// ---------------------------------------------------------------- measuring runs

export interface RunMeasure {
  ms: number;
  providerCalls: number;
  /** Jev's own reported usage; absent when no decision was made (an exact decision-cache hit) or offline. */
  jevRequests: number;
  inputTokens: number;
  outputTokens: number;
  reusedDecision: boolean;
  decisionsReusedFrom?: string;
  filesReused: number;
  filesRefreshed: number;
  memoryCandidates: number;
  candidates: string[];
  selected: string[];
  runId?: string;
}

export interface Measured {
  measure: RunMeasure;
  result: ScopeResult;
}

async function measuredRun(
  ctx: BenchContext,
  repo: string,
  task: LabeledTask,
  text: string,
  options: { cache?: boolean; memory?: boolean; reuse?: boolean } = {},
): Promise<Measured> {
  const { chunks } = await loadChunks(repo);
  const counter = countingProvider(ctx, task, chunks);
  const started = performance.now();
  const { result } = await runScope({
    task: text,
    repo,
    provider: counter.provider,
    cache: options.cache ?? true,
    reuseDecisions: options.reuse ?? true,
    cacheOptions: {
      integrityEnv: ctx.integrityEnv,
      env: options.memory === false ? { SCOPE_MEMORY: "off" } : {},
    },
  });
  const ms = performance.now() - started;
  return {
    result,
    measure: {
      ms,
      providerCalls: counter.calls,
      jevRequests: result.jev?.requestCount ?? 0,
      inputTokens: result.jev?.usage.inputTokens ?? 0,
      outputTokens: result.jev?.usage.outputTokens ?? 0,
      reusedDecision: result.cache?.decision?.reused ?? false,
      ...(result.decisionsReusedFrom === undefined ? {} : { decisionsReusedFrom: result.decisionsReusedFrom }),
      filesReused: result.cache?.files.reused ?? 0,
      filesRefreshed: result.cache?.files.refreshed ?? 0,
      memoryCandidates: result.cache?.memory?.candidates ?? 0,
      // Captured at the provider boundary: the selection output cannot tell a candidate that was kept only as a
      // supporting declaration from one that was never shown.
      candidates: [...counter.candidates],
      selected: result.chunks.map((entry) => entry.chunk.id),
      ...(result.runId === undefined ? {} : { runId: result.runId }),
    },
  };
}

export interface Recall {
  requiredFound: number;
  requiredTotal: number;
  usefulFound: number;
  usefulTotal: number;
}

/** Shortlist recall (the ids Jev was shown) and selected recall (the ids Scope emitted) for one task's labels. */
function recallOf(task: LabeledTask, chunks: readonly CodeChunk[], measure: RunMeasure) {
  const count = (labels: string[], ids: string[]) => labelRecall(labels, chunks, new Set(ids), task.id).found.length;
  const shape = (ids: string[]): Recall => ({
    requiredFound: count(task.required, ids),
    requiredTotal: task.required.length,
    usefulFound: count(task.useful, ids),
    usefulTotal: task.useful.length,
  });
  return { shortlist: shape(measure.candidates), selected: shape(measure.selected) };
}

/**
 * Feedback as a user would give it for `run` of a tuning task: `--useful` for the required labels Jev selected,
 * `--missing` for the required labels it did not. Refuses a held-out task, so no held-out label is ever submitted.
 */
export async function submitTuningFeedback(
  ctx: BenchContext,
  fixture: string,
  repo: string,
  task: LabeledTask,
  run: Measured,
): Promise<{ useful: number; missing: number } | undefined> {
  if (task.split !== "tuning") throw new Error(`feedback refused: ${task.id} is a ${task.split} task`);
  const runId = run.measure.runId;
  if (runId === undefined) return undefined;
  const { chunks } = await loadChunks(repo);
  const candidates = new Set(run.measure.candidates);
  const selected = new Set(run.measure.selected);
  const useful: string[] = [];
  const missing: string[] = [];
  for (const label of task.required) {
    for (const chunk of resolve(label, chunks)) {
      if (selected.has(chunk.id) && candidates.has(chunk.id)) useful.push(chunk.id);
      else missing.push(`${chunk.file}:${chunk.startLine}-${chunk.endLine}`);
    }
  }
  if (useful.length + missing.length === 0) return undefined;
  ctx.feedbackLog.push({ fixture, task: task.id, split: task.split });
  await submitFeedback(
    { runId, useful, irrelevant: [], missing },
    { repo, env: {}, cacheOptions: { integrityEnv: ctx.integrityEnv } },
  );
  return { useful: useful.length, missing: missing.length };
}

// ---------------------------------------------------------------- scenario 1: cold vs warm parse

export interface ParseRow {
  repo: string;
  chunks: number;
  files: number;
  /** Per repeat. */
  offMs: number[];
  coldMs: number[];
  warmMs: number[];
  editMs: number[];
  cold: { reused: number; analyzed: number }[];
  warm: { reused: number; analyzed: number; statHits: number }[];
  edit: { reused: number; analyzed: number; statHits: number }[];
  /** Inventory equality of cache-off, cold, warm and edited runs against uncached loads of the same tree. */
  equal: boolean;
}

const inventory = (chunks: readonly CodeChunk[]) => JSON.stringify(chunks);

export async function scenarioParse(
  ctx: BenchContext,
  repos: { name: string; source: string; subdir?: string }[],
): Promise<ParseRow[]> {
  const rows: ParseRow[] = [];
  // One untimed load first, so the one-time grammar loading is not charged to whichever timed run happens to be first.
  if (repos[0]) await loadChunks(repos[0].source);
  for (const repo of repos) {
    const row: ParseRow = {
      repo: repo.name,
      chunks: 0,
      files: 0,
      offMs: [],
      coldMs: [],
      warmMs: [],
      editMs: [],
      cold: [],
      warm: [],
      edit: [],
      equal: true,
    };
    for (let i = 0; i < ctx.repeats; i++) {
      const root = await workspace(ctx, repo.source, repo.subdir);
      const cache = { integrityEnv: ctx.integrityEnv };
      const timed = async (on: boolean) => {
        const started = performance.now();
        const loaded = await loadChunks(root, on ? { cache } : {});
        return { ms: performance.now() - started, loaded };
      };
      const off = await timed(false);
      const cold = await timed(true);
      const warm = await timed(true);
      const baseline = inventory(off.loaded.chunks);
      row.chunks = off.loaded.chunks.length;
      row.files = new Set(off.loaded.chunks.map((chunk) => chunk.file)).size;
      row.equal &&= inventory(cold.loaded.chunks) === baseline && inventory(warm.loaded.chunks) === baseline;
      // Edit one TypeScript file (the first, by path) and reload warm.
      const target = [...new Set(off.loaded.chunks.map((chunk) => chunk.file))].sort().find((f) => f.endsWith(".ts"));
      if (target === undefined) throw new Error(`${repo.name}: no TypeScript file to edit`);
      const path = join(root, target);
      await writeFile(path, `${await readFile(path, "utf8")}\n// bench edit\n`);
      const edited = await timed(true);
      const expected = inventory((await loadChunks(root)).chunks);
      row.equal &&= inventory(edited.loaded.chunks) === expected;
      row.offMs.push(off.ms);
      row.coldMs.push(cold.ms);
      row.warmMs.push(warm.ms);
      row.editMs.push(edited.ms);
      const pick = (loaded: typeof cold.loaded) => ({
        reused: loaded.analysis?.reused ?? 0,
        analyzed: loaded.analysis?.analyzed ?? 0,
        statHits: loaded.analysis?.statHits ?? 0,
      });
      row.cold.push({ reused: pick(cold.loaded).reused, analyzed: pick(cold.loaded).analyzed });
      row.warm.push(pick(warm.loaded));
      row.edit.push(pick(edited.loaded));
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- scenario 2: repeated identical task

export interface RepeatRow {
  fixture: string;
  task: string;
  /** Per repeat. */
  uncached: RunMeasure[];
  first: RunMeasure[];
  second: RunMeasure[];
  forced: RunMeasure[];
  sameSelection: boolean;
}

export async function scenarioRepeat(ctx: BenchContext, fixture: string): Promise<RepeatRow[]> {
  const rows: RepeatRow[] = [];
  for (const task of (await loadLabeledTasks(fixture)).filter((t) => t.split === "tuning")) {
    const row: RepeatRow = {
      fixture,
      task: task.id,
      uncached: [],
      first: [],
      second: [],
      forced: [],
      sameSelection: true,
    };
    for (let i = 0; i < ctx.repeats; i++) {
      const root = await workspace(ctx, fixtureDir(fixture));
      row.uncached.push((await measuredRun(ctx, root, task, task.task, { cache: false })).measure);
      const first = await measuredRun(ctx, root, task, task.task);
      const second = await measuredRun(ctx, root, task, task.task);
      // The same task with decision reuse switched off (`--fresh`): what the second run would cost without it.
      const forced = await measuredRun(ctx, root, task, task.task, { reuse: false });
      row.first.push(first.measure);
      row.second.push(second.measure);
      row.forced.push(forced.measure);
      row.sameSelection &&= JSON.stringify(first.measure.selected) === JSON.stringify(second.measure.selected);
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- scenario 3: related task

export interface RelatedArm {
  /** Fresh retrieval is identical for both arms, so only the appended memory candidates can differ. */
  shortlist: Recall;
  selected: Recall;
  measure: RunMeasure;
  similarity?: number;
}

export interface RelatedRow {
  fixture: string;
  task: string;
  feedback: { useful: number; missing: number } | undefined;
  /** Per repeat. */
  memoryOn: RelatedArm[];
  memoryOff: RelatedArm[];
  /** Memory-on shortlist minus memory-off shortlist, as ids, per repeat: only appended memory candidates. */
  addedByMemory: string[][];
  onlyAppended: boolean;
}

/** Runs the original task, gives feedback as a user would, and returns the repository ready for the paraphrase. */
async function primedWorkspace(
  ctx: BenchContext,
  fixture: string,
  tasks: LabeledTask[],
): Promise<{ root: string; feedback: Map<string, { useful: number; missing: number } | undefined> }> {
  const root = await workspace(ctx, fixtureDir(fixture));
  const feedback = new Map<string, { useful: number; missing: number } | undefined>();
  for (const task of tasks) {
    const run = await measuredRun(ctx, root, task, task.task);
    feedback.set(task.id, await submitTuningFeedback(ctx, fixture, root, task, run));
  }
  return { root, feedback };
}

/** True when `on` is `off` followed by extra ids: memory may only append, never drop or reorder fresh candidates. */
export const onlyAppended = (off: readonly string[], on: readonly string[]): boolean =>
  on.length >= off.length && off.every((id, index) => on[index] === id);

export async function scenarioRelated(ctx: BenchContext, fixture: string): Promise<RelatedRow[]> {
  const rows: RelatedRow[] = [];
  const tuning = (await loadLabeledTasks(fixture)).filter((t) => t.split === "tuning");
  for (const task of tuning) {
    const paraphrase = PARAPHRASES[task.id];
    if (paraphrase === undefined) throw new Error(`no paraphrase for ${task.id}`);
    const row: RelatedRow = {
      fixture,
      task: task.id,
      feedback: undefined,
      memoryOn: [],
      memoryOff: [],
      addedByMemory: [],
      onlyAppended: true,
    };
    for (let i = 0; i < ctx.repeats; i++) {
      const arms: RelatedArm[] = [];
      for (const memory of [true, false]) {
        // One repository per arm, primed the same way, so neither arm sees the other's paraphrase run.
        const primed = await primedWorkspace(ctx, fixture, [task]);
        row.feedback = primed.feedback.get(task.id);
        const { chunks } = await loadChunks(primed.root);
        const run = await measuredRun(ctx, primed.root, task, paraphrase, { memory, reuse: false });
        const memoryEntry = run.result.chunks.find((entry) => entry.memory !== undefined);
        arms.push({
          ...recallOf(task, chunks, run.measure),
          measure: run.measure,
          ...(memoryEntry?.memory ? { similarity: memoryEntry.memory.similarity } : {}),
        });
      }
      const [on, off] = arms as [RelatedArm, RelatedArm];
      row.memoryOn.push(on);
      row.memoryOff.push(off);
      const offIds = off.measure.candidates;
      row.addedByMemory.push(on.measure.candidates.slice(offIds.length));
      row.onlyAppended &&= onlyAppended(offIds, on.measure.candidates);
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- scenario 4: unseen task

export interface UnseenRow {
  fixture: string;
  task: string;
  split: LabeledTask["split"];
  /** Per repeat: shortlist recall with an empty store and with history from the other tuning tasks. */
  emptyOn: Recall[];
  emptyOff: Recall[];
  historyOn: Recall[];
  historyOff: Recall[];
  memoryCandidates: number[];
  /** Required and useful candidate recall with history never below the empty store's, memory on and off alike. */
  recallHeld: boolean;
}

/** True when `after` finds at least as many required labels and at least as many useful labels as `before`. */
export const recallNotLower = (after: Recall, before: Recall): boolean =>
  after.requiredFound >= before.requiredFound && after.usefulFound >= before.usefulFound;

export async function scenarioUnseen(ctx: BenchContext, fixture: string): Promise<UnseenRow[]> {
  const rows: UnseenRow[] = [];
  const all = await loadLabeledTasks(fixture);
  for (const task of all) {
    // History comes from the other tuning tasks only: a held-out run never enters a store, and the task itself never
    // does either (it has to be unseen).
    const others = all.filter((other) => other.split === "tuning" && other.id !== task.id);
    const row: UnseenRow = {
      fixture,
      task: task.id,
      split: task.split,
      emptyOn: [],
      emptyOff: [],
      historyOn: [],
      historyOff: [],
      memoryCandidates: [],
      recallHeld: true,
    };
    for (let i = 0; i < ctx.repeats; i++) {
      const measure = async (history: boolean, memory: boolean) => {
        const root = history
          ? (await primedWorkspace(ctx, fixture, others)).root
          : await workspace(ctx, fixtureDir(fixture));
        const { chunks } = await loadChunks(root);
        const run = await measuredRun(ctx, root, task, task.task, { memory });
        return { recall: recallOf(task, chunks, run.measure).shortlist, added: run.measure.memoryCandidates };
      };
      const emptyOn = await measure(false, true);
      const emptyOff = await measure(false, false);
      const historyOn = await measure(true, true);
      const historyOff = await measure(true, false);
      row.emptyOn.push(emptyOn.recall);
      row.emptyOff.push(emptyOff.recall);
      row.historyOn.push(historyOn.recall);
      row.historyOff.push(historyOff.recall);
      row.memoryCandidates.push(historyOn.added);
      row.recallHeld &&=
        recallNotLower(historyOn.recall, emptyOn.recall) && recallNotLower(historyOff.recall, emptyOff.recall);
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- scenario 5: adaptive weights

export interface AdaptiveRow {
  fixture: string;
  feedbackRuns: number;
  report: Omit<AdaptationReport, "warnings"> & { warnings: number };
}

/** Gathers feedback for the originals and the paraphrases (tuning only), then runs #78's held-out gate on the copy. */
export async function scenarioAdaptive(ctx: BenchContext, fixture: string): Promise<AdaptiveRow> {
  const tuning = (await loadLabeledTasks(fixture)).filter((t) => t.split === "tuning");
  const root = await workspace(ctx, fixtureDir(fixture));
  let runs = 0;
  for (const task of tuning) {
    for (const text of [task.task, PARAPHRASES[task.id]!]) {
      const run = await measuredRun(ctx, root, task, text, { reuse: false });
      if (await submitTuningFeedback(ctx, fixture, root, task, run)) runs++;
    }
  }
  // Promotion, if the gate allows it, is written into this temporary copy only.
  const report = await runAdaptation({ repo: root, fixture, promote: true, integrityEnv: ctx.integrityEnv });
  return { fixture, feedbackRuns: runs, report: { ...report, warnings: report.warnings.length } };
}

// ---------------------------------------------------------------- reporting

const fmt = (n: number, digits = 0) => n.toFixed(digits);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const range = (xs: number[], digits = 0) =>
  `${fmt(mean(xs), digits)} (${fmt(Math.min(...xs), digits)}-${fmt(Math.max(...xs), digits)})`;
const frac = (found: number, total: number) => (total === 0 ? "n/a" : `${found}/${total}`);

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export interface BenchResults {
  mode: "offline" | "live";
  repeats: number;
  date: string;
  machine: { platform: string; arch: string; cpu: string; cores: number; bun: string; node: string };
  parse: ParseRow[];
  repeat: RepeatRow[];
  related: RelatedRow[];
  unseen: UnseenRow[];
  adaptive: AdaptiveRow;
  feedbackSubmitted: { tuning: number; heldout: number };
}

const recallText = (r: Recall) =>
  `${frac(r.requiredFound, r.requiredTotal)} req, ${frac(r.usefulFound, r.usefulTotal)} useful`;
/** The repeats' recall, or the first one's with a "~" when the repeats disagree (live runs can). */
const recallCell = (rs: Recall[]) => {
  const texts = new Set(rs.map(recallText));
  return texts.size === 1 ? [...texts][0]! : `~${recallText(rs[0]!)} (varies: ${[...texts].join(" | ")})`;
};

export function formatResults(r: BenchResults): string {
  const out: string[] = [];
  out.push(`mode: ${r.mode}   repeats: ${r.repeats}   ${r.date}   ${r.machine.platform}/${r.machine.arch}`);
  out.push(`bun ${r.machine.bun}, node ${r.machine.node}, ${r.machine.cores} cores (${r.machine.cpu})`);
  out.push("\n1. Cold vs warm parse (loadChunks; mean ms (min-max); reuse counts are from the last repeat)");
  out.push(
    table(
      [
        "repo",
        "files",
        "chunks",
        "off ms",
        "cold ms",
        "warm ms",
        "edit ms",
        "warm reused/parsed",
        "edit reused/parsed",
        "equal",
      ],
      r.parse.map((p) => [
        p.repo,
        String(p.files),
        String(p.chunks),
        range(p.offMs, 1),
        range(p.coldMs, 1),
        range(p.warmMs, 1),
        range(p.editMs, 1),
        `${p.warm.at(-1)!.reused}/${p.warm.at(-1)!.analyzed}`,
        `${p.edit.at(-1)!.reused}/${p.edit.at(-1)!.analyzed}`,
        String(p.equal),
      ]),
    ),
  );
  out.push("\n2. Repeated identical task (mean ms (min-max); Jev requests and provider calls summed over repeats)");
  out.push(
    table(
      [
        "task",
        "no cache ms",
        "1st ms",
        "2nd ms",
        "--fresh ms",
        "1st calls",
        "2nd calls",
        "2nd Jev reqs",
        "2nd reused",
        "same sel.",
      ],
      r.repeat.map((p) => [
        p.task,
        range(
          p.uncached.map((m) => m.ms),
          1,
        ),
        range(
          p.first.map((m) => m.ms),
          1,
        ),
        range(
          p.second.map((m) => m.ms),
          1,
        ),
        range(
          p.forced.map((m) => m.ms),
          1,
        ),
        String(p.first.reduce((s, m) => s + m.providerCalls, 0)),
        String(p.second.reduce((s, m) => s + m.providerCalls, 0)),
        String(p.second.reduce((s, m) => s + m.jevRequests, 0)),
        String(p.second.filter((m) => m.reusedDecision && m.decisionsReusedFrom !== undefined).length),
        String(p.sameSelection),
      ]),
    ),
  );
  out.push(
    "\n3. Related task (paraphrase after the original and its feedback; shortlist recall,",
    "   same in every repeat unless marked ~)",
  );
  out.push(
    table(
      ["task", "feedback", "memory", "shortlist recall", "selected recall", "mem cands", "cands", "ms", "Jev reqs"],
      r.related.flatMap((p) =>
        (["on", "off"] as const).map((arm) => {
          const arms = arm === "on" ? p.memoryOn : p.memoryOff;
          return [
            p.task,
            p.feedback ? `${p.feedback.useful} useful, ${p.feedback.missing} missing` : "none",
            arm,
            recallCell(arms.map((a) => a.shortlist)),
            recallCell(arms.map((a) => a.selected)),
            range(arms.map((a) => a.measure.memoryCandidates)),
            range(arms.map((a) => a.measure.candidates.length)),
            range(
              arms.map((a) => a.measure.ms),
              1,
            ),
            range(arms.map((a) => a.measure.jevRequests)),
          ];
        }),
      ),
    ),
  );
  out.push("\n4. Unseen task (shortlist recall, same in every repeat unless marked ~)");
  out.push(
    table(
      [
        "task",
        "split",
        "empty, memory on",
        "empty, memory off",
        "history, memory on",
        "history, memory off",
        "mem cands",
        "held",
      ],
      r.unseen.map((p) => [
        p.task,
        p.split,
        recallCell(p.emptyOn),
        recallCell(p.emptyOff),
        recallCell(p.historyOn),
        recallCell(p.historyOff),
        range(p.memoryCandidates),
        String(p.recallHeld),
      ]),
    ),
  );
  const a = r.adaptive.report;
  out.push("\n5. Adaptive weights (#78 held-out gate on the scenario 3 feedback, promoted only into the temp copy)");
  out.push(
    [
      `feedback runs: ${r.adaptive.feedbackRuns}, ${a.identity ? "proposal is the identity" : "proposal learned"}`,
      `multipliers: ${Object.entries(a.multipliers)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
      `held-out tasks: ${a.evaluation.tasks}; ` +
        `baseline recall ${frac(a.evaluation.baseline.found, a.evaluation.baseline.total)}; ` +
        `proposal recall ${frac(a.evaluation.proposal.found, a.evaluation.proposal.total)}`,
      a.outcome.promoted ? `promoted ${a.outcome.record.version}` : `not promoted: ${a.outcome.reason}`,
    ].join("\n"),
  );
  out.push(`\nfeedback submitted: ${r.feedbackSubmitted.tuning} tuning, ${r.feedbackSubmitted.heldout} held-out`);
  return out.join("\n");
}

/** The raw numbers for the report: ids, counts and timings only; no task text, no source, no key. */
export const rawResults = (r: BenchResults): BenchResults => r;

export async function runBenchmark(options: { live?: boolean; repeats?: number } = {}): Promise<BenchResults> {
  const ctx = await createContext(options);
  try {
    const fixtures = (await readdir(TASKS))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
    const parse = await scenarioParse(ctx, [
      ...fixtures.map((name) => ({ name, source: fixtureDir(name) })),
      { name: "scope src/", source: join(ROOT, "src"), subdir: "src" },
    ]);
    const repeat: RepeatRow[] = [];
    const related: RelatedRow[] = [];
    const unseen: UnseenRow[] = [];
    const adaptive: AdaptiveRow[] = [];
    for (const fixture of fixtures) {
      repeat.push(...(await scenarioRepeat(ctx, fixture)));
      related.push(...(await scenarioRelated(ctx, fixture)));
      unseen.push(...(await scenarioUnseen(ctx, fixture)));
      adaptive.push(await scenarioAdaptive(ctx, fixture));
    }
    const cpu = cpus();
    return {
      mode: ctx.live ? "live" : "offline",
      repeats: ctx.repeats,
      date: new Date().toISOString().slice(0, 10),
      machine: {
        platform: platform(),
        arch: arch(),
        cpu: cpu[0]?.model ?? "unknown",
        cores: cpu.length,
        bun: Bun.version,
        node: process.versions.node,
      },
      parse,
      repeat,
      related,
      unseen,
      adaptive: adaptive[0]!,
      feedbackSubmitted: {
        tuning: ctx.feedbackLog.filter((f) => f.split === "tuning").length,
        heldout: ctx.feedbackLog.filter((f) => f.split === "heldout").length,
      },
    };
  } finally {
    await ctx.dispose();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const repeatsAt = args.indexOf("--repeats");
  const outAt = args.indexOf("--out");
  const repeats = repeatsAt >= 0 ? Number(args[repeatsAt + 1]) : 3;
  if (!Number.isInteger(repeats) || repeats < 1) {
    console.error("Usage: bun scripts/bench-cache.ts [--live] [--repeats N] [--out <file>]");
    process.exit(2);
  }
  if (live && !process.env.TYPESAFE_API_KEY?.trim()) {
    console.error("--live needs TYPESAFE_API_KEY in the environment.");
    process.exit(2);
  }
  const results = await runBenchmark({ live, repeats });
  console.log(formatResults(results));
  if (outAt >= 0) {
    const out = args[outAt + 1];
    if (!out) {
      console.error("--out needs a file path.");
      process.exit(2);
    }
    await writeFile(out, `${JSON.stringify(rawResults(results), null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
  if (!results.parse.every((p) => p.equal) || results.feedbackSubmitted.heldout !== 0) process.exit(1);
}
