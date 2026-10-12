// The evaluation runner: selects context for every labeled task in each mode and scores it against the labels.
// Dev tooling (Bun allowed). It never writes into a fixture and never prints credentials.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { JEV_QUESTION_VERSION } from "../../src/config.ts";
import { JevDecisionProvider, jevModel } from "../../src/jev/provider.ts";
import { scanRepository, type SkipReason } from "../../src/repository/files.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../../src/retrieval/config.ts";
import { buildIndexes, scoreText, type RetrievalIndexes } from "../../src/retrieval/indexes.ts";
import { extractTaskTerms } from "../../src/retrieval/terms.ts";
import { loadChunks, runScope } from "../../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../../src/types.ts";
import { assertFixtureLock, assertFrozen, EvalError, labelsChecksum } from "./freeze.ts";
import { FIXTURES, listTaskFixtures, loadLabeledTasks, unitOf, type LabeledTask } from "./labels.ts";
import { COVERAGE_THRESHOLD, isCovered, lineSetsOf, type LineRange } from "./matching.ts";
import {
  characterShares,
  mean,
  pairedDifference,
  precision,
  requiredRecall,
  sizeReduction,
  spread,
  type LabeledUnits,
  type Ratio,
  type Spread,
} from "./metrics.ts";
import {
  readRecording,
  recordingProvider,
  replayProvider,
  writeRecording,
  type RecordedDecision,
} from "./recording.ts";
import { renderReport } from "./report.ts";

/** The fixed size of the lexical baseline: the ten best BM25 chunks, whatever the task. */
export const LEXICAL_TOP_K = 10;

export const MODES = ["lexical", "no-jev", "jev"] as const;
export type Mode = (typeof MODES)[number];
export const SPLITS = ["tuning", "heldout", "all"] as const;
export type SplitChoice = (typeof SPLITS)[number];
export type SplitKey = "tuning" | "heldout" | "all";

const REPO_ROOT = join(import.meta.dir, "../..");

export interface EvalOptions {
  modes: readonly Mode[];
  split: SplitChoice;
  /** Restrict to these fixtures (default: all). */
  fixtures?: readonly string[];
  record?: string;
  replay?: string;
  repeat: number;
  outDir: string;
  /** Test hook: stands in for the real Jev provider (the live path needs TYPESAFE_API_KEY). */
  provider?: DecisionProvider;
  now?: () => Date;
  /** Progress lines go here (default: stderr). */
  log?: (line: string) => void;
}

export interface SelectedRef extends LineRange {
  id: string;
  name?: string;
}

export interface JevOverhead {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  requestCount?: number;
}

export interface RunSummary {
  recall: number | null;
  precision: number | null;
  selectedChars: number;
  jev: JevOverhead | null;
}

export interface TaskModeResult {
  selectedChunks: number;
  selectedChars: number;
  recall: Ratio;
  precision: Ratio;
  irrelevantChars: number;
  irrelevantRate: number | null;
  unlabeledChars: number;
  unlabeledShare: number | null;
  sizeReduction: number | null;
  /** Required labels the selection does not cover. */
  missedRequired: string[];
  selected: { file: string; startLine: number; endLine: number; name?: string }[];
  /** Jev's overhead (jev mode only); null when Jev was not called or reported no usage. */
  jev?: JevOverhead | null;
  /** Every repetition, first one included, when `--repeat` is above 1. The headline numbers are the first run's. */
  runs?: RunSummary[];
}

export interface FixtureBaseline {
  eligibleFiles: number;
  /** Characters of all eligible scanned files (decoded UTF-8), the denominator of size reduction. */
  eligibleChars: number;
  /** Excluded paths per reason; a directory skipped as a whole counts once. */
  exclusions: Partial<Record<SkipReason | "binary-content", number>>;
}

export interface TaskEntry {
  id: string;
  fixture: string;
  split: "tuning" | "heldout";
  task: string;
  modes: Partial<Record<Mode, TaskModeResult>>;
}

export interface Aggregate {
  tasks: number;
  recall: { macro: number | null; covered: number; required: number; micro: number | null };
  precision: { macro: number | null; definedTasks: number };
  irrelevantRate: { macro: number | null };
  unlabeledShare: { macro: number | null };
  selectedChars: { total: number; mean: number | null };
  sizeReduction: { macro: number | null };
}

export interface ImpactRow {
  id: string;
  fixture: string;
  split: "tuning" | "heldout";
  recall: number | null;
  precision: number | null;
  selectedChars: number;
}

export interface ImpactAggregate {
  tasks: number;
  recall: number | null;
  precision: number | null;
  selectedChars: number | null;
  recallImproved: number;
  recallWorse: number;
  recallSame: number;
}

export interface OverheadRow {
  id: string;
  fixture: string;
  split: "tuning" | "heldout";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  combinedTokens: number;
}

export interface OverheadAggregate {
  tasks: number;
  latencyMs: { total: number; mean: number | null };
  inputTokens: number;
  outputTokens: number;
  combinedTokens: number;
}

export interface VariabilityRow {
  id: string;
  fixture: string;
  repeats: number;
  recall: Spread | null;
  precision: Spread | null;
  selectedChars: Spread | null;
  latencyMs: Spread | null;
  inputTokens: Spread | null;
  outputTokens: Spread | null;
}

export interface Finding {
  id: string;
  fixture: string;
  split: "tuning" | "heldout";
  kind: "recall-regression" | "identical-selection" | "no-gain";
  detail: string;
}

export interface EvalResults {
  baseline: Record<string, FixtureBaseline>;
  tasks: TaskEntry[];
  aggregates: Partial<Record<Mode, Partial<Record<SplitKey, Aggregate>>>>;
  impact?: { tasks: ImpactRow[]; aggregates: Partial<Record<SplitKey, ImpactAggregate>> };
  overhead?: { tasks: OverheadRow[]; aggregates: Partial<Record<SplitKey, OverheadAggregate>> };
  variability?: VariabilityRow[];
  findings?: Finding[];
}

export interface RunBlock {
  scopeVersion: string;
  retrievalConfigVersion: string;
  jevQuestionVersion: string;
  sdkVersion: string;
  model: string;
  commit: string;
  dirty: boolean;
  labelsChecksum: string;
  fixtureLock: Record<string, string>;
  modes: Mode[];
  split: SplitChoice;
  fixtures: string[];
  repeat: number;
  lexicalTopK: number;
  coverageThreshold: number;
  startedAt: string;
  finishedAt: string;
  record?: string;
  replay?: { file: string; model: string; sdkVersion: string; recordedAt: string; commit: string };
}

export interface EvalOutput {
  run: RunBlock;
  results: EvalResults;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareChunks = (a: CodeChunk, b: CodeChunk) =>
  compareText(a.file, b.file) || a.startLine - b.startLine || compareText(a.id, b.id);

/** Rejects option combinations that cannot work, before anything is read or sent. */
export function validateOptions(options: EvalOptions): void {
  const { modes, record, replay, repeat } = options;
  if (modes.length === 0) throw new EvalError("At least one --mode is required.");
  if (!Number.isInteger(repeat) || repeat < 1) throw new EvalError("--repeat must be a whole number of at least 1.");
  if ((record || replay) && !modes.includes("jev"))
    throw new EvalError("--record and --replay apply to the jev mode; add --mode jev.");
  if (record && replay) throw new EvalError("--record and --replay cannot be combined.");
  if (repeat > 1 && !modes.includes("jev")) throw new EvalError("--repeat is only valid with --mode jev.");
  if (repeat > 1 && replay)
    throw new EvalError("--repeat cannot be used with --replay: a replay returns the same decision every time.");
  if (repeat > 1 && record)
    throw new EvalError("--repeat cannot be used with --record: a recording holds one decision per task.");
}

interface FixtureContext {
  name: string;
  root: string;
  chunks: CodeChunk[];
  baseline: FixtureBaseline;
  /** Characters of each line (newline included) by file, so a whole file adds up to its length. */
  weights: Map<string, number[]>;
  indexes?: RetrievalIndexes;
}

/** The eligible repository under Scope's own scan rules, with what the scan left out. */
async function loadFixture(name: string): Promise<FixtureContext> {
  const root = join(FIXTURES, name);
  const { chunks } = await loadChunks(root);
  const scan = await scanRepository(root);
  const weights = new Map<string, number[]>();
  const exclusions: FixtureBaseline["exclusions"] = {};
  const exclude = (reason: SkipReason | "binary-content") => (exclusions[reason] = (exclusions[reason] ?? 0) + 1);
  for (const { reason } of scan.skipped) exclude(reason);
  let eligibleChars = 0;
  let eligibleFiles = 0;
  for (const file of scan.files) {
    const bytes = await readFile(join(root, file));
    // The scanner sniffs only the start of a file; Scope itself drops a file with a NUL anywhere.
    if (bytes.includes(0)) {
      exclude("binary-content");
      continue;
    }
    const text = bytes.toString("utf8");
    eligibleChars += text.length;
    eligibleFiles += 1;
    weights.set(
      file,
      text.split(/(?<=\n)/u).map((line) => line.length),
    );
  }
  const sorted = Object.fromEntries(Object.entries(exclusions).sort(([a], [b]) => compareText(a, b)));
  return { name, root, chunks, weights, baseline: { eligibleFiles, eligibleChars, exclusions: sorted } };
}

function unitsOf(task: LabeledTask, chunks: readonly CodeChunk[]): LabeledUnits {
  return {
    required: task.required.map((label) => unitOf(label, chunks)),
    useful: task.useful.map((label) => unitOf(label, chunks)),
    irrelevant: task.irrelevant.map((label) => unitOf(label, chunks)),
  };
}

const refOf = (chunk: CodeChunk): SelectedRef => ({
  id: chunk.id,
  file: chunk.file,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  ...(chunk.name === undefined ? {} : { name: chunk.name }),
});

/** The lexical baseline: BM25 over every eligible chunk, using the task's content words, best LEXICAL_TOP_K. */
export function lexicalSelect(task: string, ctx: { chunks: readonly CodeChunk[]; indexes?: RetrievalIndexes }) {
  const indexes = (ctx.indexes ??= buildIndexes(ctx.chunks));
  const scores = scoreText(indexes, extractTaskTerms(task).words);
  return [...scores]
    .map(([id, score]) => ({ chunk: indexes.byId.get(id)!, score }))
    .sort((a, b) => b.score - a.score || compareChunks(a.chunk, b.chunk))
    .slice(0, LEXICAL_TOP_K)
    .map(({ chunk }) => refOf(chunk));
}

interface Selection {
  selected: SelectedRef[];
  jev?: JevOverhead | null;
}

async function select(
  mode: Mode,
  task: LabeledTask,
  ctx: FixtureContext,
  provider: DecisionProvider | undefined,
): Promise<Selection> {
  if (mode === "lexical") return { selected: lexicalSelect(task.task, ctx) };
  const { result } = await runScope({ task: task.task, repo: ctx.root, noJev: mode === "no-jev", provider });
  const selected = result.chunks.map(({ chunk }) => refOf(chunk));
  if (mode === "no-jev") return { selected };
  const { jev } = result;
  return {
    selected,
    jev: jev
      ? {
          latencyMs: jev.latencyMs,
          inputTokens: jev.usage.inputTokens,
          outputTokens: jev.usage.outputTokens,
          ...(jev.requestCount === undefined ? {} : { requestCount: jev.requestCount }),
        }
      : null,
  };
}

function score(
  { selected, jev }: Selection,
  task: LabeledTask,
  units: LabeledUnits,
  ctx: FixtureContext,
): TaskModeResult {
  const lines = lineSetsOf(selected);
  const shares = characterShares(lines, units, (file, line) => ctx.weights.get(file)?.[line - 1] ?? 0);
  const sorted = [...selected].sort(
    (a, b) => compareText(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  return {
    selectedChunks: selected.length,
    selectedChars: shares.selectedChars,
    recall: requiredRecall(units.required, selected),
    precision: precision(selected, units),
    irrelevantChars: shares.irrelevantChars,
    irrelevantRate: shares.irrelevantRate,
    unlabeledChars: shares.unlabeledChars,
    unlabeledShare: shares.unlabeledShare,
    sizeReduction: sizeReduction(shares.selectedChars, ctx.baseline.eligibleChars),
    missedRequired: task.required.filter((_label, i) => !isCovered(units.required[i]!, lines)),
    selected: sorted.map(({ file, startLine, endLine, name }) => ({
      file,
      startLine,
      endLine,
      ...(name === undefined ? {} : { name }),
    })),
    ...(jev === undefined ? {} : { jev }),
  };
}

function aggregate(rows: readonly TaskModeResult[]): Aggregate {
  const covered = rows.reduce((sum, row) => sum + row.recall.count, 0);
  const required = rows.reduce((sum, row) => sum + row.recall.total, 0);
  const total = rows.reduce((sum, row) => sum + row.selectedChars, 0);
  return {
    tasks: rows.length,
    recall: {
      macro: mean(rows.map((row) => row.recall.value)),
      covered,
      required,
      micro: required === 0 ? null : covered / required,
    },
    precision: {
      macro: mean(rows.map((row) => row.precision.value)),
      definedTasks: rows.filter((row) => row.precision.value !== null).length,
    },
    irrelevantRate: { macro: mean(rows.map((row) => row.irrelevantRate)) },
    unlabeledShare: { macro: mean(rows.map((row) => row.unlabeledShare)) },
    selectedChars: { total, mean: rows.length === 0 ? null : total / rows.length },
    sizeReduction: { macro: mean(rows.map((row) => row.sizeReduction)) },
  };
}

const keysFor = (tasks: readonly TaskEntry[]): SplitKey[] => {
  const splits = (["tuning", "heldout"] as const).filter((s) => tasks.some((t) => t.split === s));
  return splits.length > 1 ? [...splits, "all"] : splits;
};
const inSplit = (entry: { split: string }, key: SplitKey) => key === "all" || entry.split === key;

/** Derived, deterministic sections of the results: aggregates, Jev impact and overhead, variability, findings. */
export function summarize(
  tasks: readonly TaskEntry[],
  baseline: Record<string, FixtureBaseline>,
  modes: readonly Mode[],
): EvalResults {
  const keys = keysFor(tasks);
  const aggregates: EvalResults["aggregates"] = {};
  for (const mode of modes) {
    const byKey: Partial<Record<SplitKey, Aggregate>> = {};
    for (const key of keys)
      byKey[key] = aggregate(
        tasks.filter((t) => inSplit(t, key)).flatMap((t) => (t.modes[mode] ? [t.modes[mode]] : [])),
      );
    aggregates[mode] = byKey;
  }
  const results: EvalResults = { baseline, tasks: [...tasks], aggregates };
  const jevTasks = tasks.filter((t) => t.modes.jev);

  if (modes.includes("jev") && modes.includes("no-jev")) {
    const rows: ImpactRow[] = tasks.flatMap((t) => {
      const [jev, base] = [t.modes.jev, t.modes["no-jev"]];
      if (!jev || !base) return [];
      const side = (m: TaskModeResult) => ({
        recall: m.recall.value,
        precision: m.precision.value,
        selectedChars: m.selectedChars,
      });
      return [{ id: t.id, fixture: t.fixture, split: t.split, ...pairedDifference(side(jev), side(base)) }];
    });
    const byKey: Partial<Record<SplitKey, ImpactAggregate>> = {};
    for (const key of keys) {
      const part = rows.filter((row) => inSplit(row, key));
      byKey[key] = {
        tasks: part.length,
        recall: mean(part.map((row) => row.recall)),
        precision: mean(part.map((row) => row.precision)),
        selectedChars: mean(part.map((row) => row.selectedChars)),
        recallImproved: part.filter((row) => (row.recall ?? 0) > 0).length,
        recallWorse: part.filter((row) => (row.recall ?? 0) < 0).length,
        recallSame: part.filter((row) => row.recall === 0).length,
      };
    }
    results.impact = { tasks: rows, aggregates: byKey };
    results.findings = findings(tasks);
  }

  if (modes.includes("jev")) {
    const rows: OverheadRow[] = jevTasks.flatMap((t) => {
      const jev = t.modes.jev?.jev;
      if (!jev) return [];
      return [
        {
          id: t.id,
          fixture: t.fixture,
          split: t.split,
          latencyMs: jev.latencyMs,
          inputTokens: jev.inputTokens,
          outputTokens: jev.outputTokens,
          combinedTokens: jev.inputTokens + jev.outputTokens,
        },
      ];
    });
    const byKey: Partial<Record<SplitKey, OverheadAggregate>> = {};
    for (const key of keys) {
      const part = rows.filter((row) => inSplit(row, key));
      const sum = (pick: (row: OverheadRow) => number) => part.reduce((total, row) => total + pick(row), 0);
      byKey[key] = {
        tasks: part.length,
        latencyMs: { total: sum((r) => r.latencyMs), mean: mean(part.map((r) => r.latencyMs)) },
        inputTokens: sum((r) => r.inputTokens),
        outputTokens: sum((r) => r.outputTokens),
        combinedTokens: sum((r) => r.combinedTokens),
      };
    }
    results.overhead = { tasks: rows, aggregates: byKey };
    const repeated = jevTasks.filter((t) => (t.modes.jev?.runs?.length ?? 0) > 1);
    if (repeated.length > 0) {
      results.variability = repeated.map((t) => {
        const runs = t.modes.jev?.runs ?? [];
        return {
          id: t.id,
          fixture: t.fixture,
          repeats: runs.length,
          recall: spread(runs.map((r) => r.recall)),
          precision: spread(runs.map((r) => r.precision)),
          selectedChars: spread(runs.map((r) => r.selectedChars)),
          latencyMs: spread(runs.map((r) => r.jev?.latencyMs ?? null)),
          inputTokens: spread(runs.map((r) => r.jev?.inputTokens ?? null)),
          outputTokens: spread(runs.map((r) => r.jev?.outputTokens ?? null)),
        };
      });
    }
  }
  return results;
}

/** Tasks where Jev lost recall, changed nothing, or gained neither recall nor precision over `no-jev`. */
function findings(tasks: readonly TaskEntry[]): Finding[] {
  const out: Finding[] = [];
  for (const t of tasks) {
    const [jev, base] = [t.modes.jev, t.modes["no-jev"]];
    if (!jev || !base) continue;
    const common = { id: t.id, fixture: t.fixture, split: t.split };
    const key = (m: TaskModeResult) => JSON.stringify(m.selected);
    const [jr, br] = [jev.recall.value, base.recall.value];
    const [jp, bp] = [jev.precision.value, base.precision.value];
    if (jr !== null && br !== null && jr < br) {
      const missed = jev.missedRequired.filter((label) => !base.missedRequired.includes(label));
      out.push({
        ...common,
        kind: "recall-regression",
        detail: `recall ${br.toFixed(2)} to ${jr.toFixed(2)}; lost ${missed.join(", ") || "none"}`,
      });
    } else if (key(jev) === key(base)) {
      out.push({ ...common, kind: "identical-selection", detail: "Jev selected exactly what no-jev selected" });
    } else if ((jr ?? 0) <= (br ?? 0) && (jp ?? 0) <= (bp ?? 0)) {
      out.push({
        ...common,
        kind: "no-gain",
        detail: "different selection, but neither recall nor precision improved",
      });
    }
  }
  return out;
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function packageVersion(path: string): Promise<string> {
  try {
    return (JSON.parse(await readFile(path, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Writes `<name>.json` and `<name>.md`, never over an earlier run: a name already taken (two runs in the same second)
 * gets a `-2`, `-3`, ... suffix. The JSON file is created exclusively, so it claims the name for its report too.
 */
async function writeNew(dir: string, name: string, content: { json: string; md: string }) {
  for (let n = 1; ; n++) {
    const base = join(dir, n === 1 ? name : `${name}-${n}`);
    try {
      await writeFile(`${base}.json`, content.json, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await writeFile(`${base}.md`, content.md, { flag: "wx" });
    return { jsonPath: `${base}.json`, markdownPath: `${base}.md` };
  }
}

const stamp = (date: Date) => `${date.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;

/**
 * The version of the installed `@typesafe-ai/sdk`, found through Node module resolution so it also works when
 * `node_modules` lives in a parent directory (a worktree nested in the repository). The package's `exports` need not
 * expose `package.json`, so this resolves the entry point and walks up to the package's own manifest.
 */
export async function installedSdkVersion(): Promise<string> {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve("@typesafe-ai/sdk"));
    for (;;) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === "@typesafe-ai/sdk") return manifest.version ?? "unknown";
      } catch {
        // No readable manifest at this level; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) return "unknown";
      dir = parent;
    }
  } catch {
    return "unknown";
  }
}

/** Runs the evaluation and writes `<stamp>.json` and `.md` under `outDir`, never over an earlier run. */
export async function runEval(options: EvalOptions): Promise<EvalOutput & { jsonPath: string; markdownPath: string }> {
  const output = await evaluate(options);
  await mkdir(options.outDir, { recursive: true });
  const { jsonPath, markdownPath } = await writeNew(options.outDir, stamp(new Date(output.run.startedAt)), {
    json: `${JSON.stringify(output, null, 2)}\n`,
    md: renderReport(output),
  });
  return { ...output, jsonPath, markdownPath };
}

/** Runs the evaluation and returns it without writing any report file (`--record` still writes its recording). */
export async function evaluate(options: EvalOptions): Promise<EvalOutput> {
  validateOptions(options);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const modes = MODES.filter((mode) => options.modes.includes(mode));
  const live = modes.includes("jev") && !options.replay && !options.provider;
  if (live && !process.env.TYPESAFE_API_KEY?.trim())
    throw new EvalError("The jev mode needs TYPESAFE_API_KEY (or --replay <file> to use a recording).");

  const checksum = options.split === "tuning" ? (await labelsChecksum()).checksum : await assertFrozen();
  const known = await listTaskFixtures();
  for (const name of options.fixtures ?? [])
    if (!known.includes(name)) throw new EvalError(`Unknown fixture ${name}. Known: ${known.join(", ")}.`);
  const fixtures = (options.fixtures?.length ? known.filter((n) => options.fixtures?.includes(n)) : known).sort();
  const fixtureLock = await assertFixtureLock(fixtures);
  const recording = options.replay ? await readRecording(options.replay) : undefined;

  const recorded: Record<string, RecordedDecision> = {};
  /** Replay, record (around the injected or real provider) or, for a plain live run, the default real provider. */
  const providerFor = (taskId: string): DecisionProvider | undefined => {
    if (recording) return replayProvider(recording, taskId);
    const base = options.provider ?? (options.record ? new JevDecisionProvider() : undefined);
    return base && options.record ? recordingProvider(base, taskId, recorded) : base;
  };
  const entries: TaskEntry[] = [];
  const baseline: Record<string, FixtureBaseline> = {};
  for (const name of fixtures) {
    const ctx = await loadFixture(name);
    const tasks = (await loadLabeledTasks(name)).filter((t) => options.split === "all" || t.split === options.split);
    if (tasks.length === 0) continue;
    baseline[name] = ctx.baseline;
    for (const task of [...tasks].sort((a, b) => compareText(a.id, b.id))) {
      const units = unitsOf(task, ctx.chunks);
      const entry: TaskEntry = { id: task.id, fixture: name, split: task.split, task: task.task, modes: {} };
      for (const mode of modes) {
        const provider = mode === "jev" ? providerFor(task.id) : undefined;
        const runs: RunSummary[] = [];
        let first: TaskModeResult | undefined;
        const times = mode === "jev" ? options.repeat : 1;
        for (let i = 0; i < times; i++) {
          const result = score(await select(mode, task, ctx, provider), task, units, ctx);
          runs.push({
            recall: result.recall.value,
            precision: result.precision.value,
            selectedChars: result.selectedChars,
            jev: result.jev ?? null,
          });
          first ??= result;
        }
        entry.modes[mode] = times > 1 && first ? { ...first, runs } : first;
        log(`${mode.padEnd(7)} ${name}/${task.id}${times > 1 ? ` x${times}` : ""}`);
      }
      entries.push(entry);
    }
  }
  entries.sort((a, b) => compareText(a.fixture, b.fixture) || compareText(a.id, b.id));
  const results = summarize(entries, baseline, modes);

  const sdkVersion = await installedSdkVersion();
  const model = recording?.model ?? jevModel();
  const commit = git("rev-parse", "HEAD");
  if (options.record) {
    await writeRecording(options.record, {
      version: 1,
      model,
      sdkVersion,
      recordedAt: startedAt.toISOString(),
      commit,
      tasks: recorded,
    });
  }
  const finishedAt = now();
  const run: RunBlock = {
    scopeVersion: await packageVersion(join(REPO_ROOT, "package.json")),
    retrievalConfigVersion: DEFAULT_RETRIEVAL_CONFIG.version,
    jevQuestionVersion: JEV_QUESTION_VERSION,
    sdkVersion,
    model,
    commit,
    dirty: git("status", "--porcelain") !== "",
    labelsChecksum: checksum,
    fixtureLock,
    modes: [...modes],
    split: options.split,
    fixtures,
    repeat: options.repeat,
    lexicalTopK: LEXICAL_TOP_K,
    coverageThreshold: COVERAGE_THRESHOLD,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ...(options.record ? { record: options.record } : {}),
    ...(recording && options.replay
      ? {
          replay: {
            file: options.replay,
            model: recording.model,
            sdkVersion: recording.sdkVersion,
            recordedAt: recording.recordedAt,
            commit: recording.commit,
          },
        }
      : {}),
  };
  return { run, results };
}
