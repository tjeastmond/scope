// Relevance-threshold sweep and blending evaluation (issue #63). Dev script, not shipped.
//   bun scripts/utility-sweep.ts [--threshold 0.5]  reads docs/evaluations/m5-runs.json only (no network) and prints tables.
//   bun scripts/utility-sweep.ts --collect          re-runs Jev live (3 repeats per labeled task) and rewrites the cache.
// The cache holds chunk ids and numbers only: no source code, no key, no error bodies.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JEV_QUESTION_VERSION, MIN_RELEVANCE } from "../src/config.ts";
import { selectByRelevance } from "../src/context/select.ts";
import { JevDecisionProvider, jevModel } from "../src/jev/provider.ts";
import { validateJudgments } from "../src/jev/validate.ts";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk, SelectedChunk } from "../src/types.ts";
import { FIXTURES, loadLabeledTasks, resolve, type LabeledTask } from "../tests/helpers/labels.ts";
import {
  blendScores,
  evaluateSelection,
  summarize,
  type SelectionEvaluation,
  type Summary,
} from "./utility-metrics.ts";

const FIXTURE = "mixed-app";
const REPEATS = 3;
const CACHE = join(import.meta.dir, "../docs/evaluations/m5-runs.json");

interface CachedCandidate {
  id: string;
  /** Jev relevance in [0, 1]. */
  relevance: number;
  /** Retrieval's deterministic total for the chunk (0 when retrieval did not rank it). */
  deterministic: number;
}

interface CachedRun {
  taskId: string;
  split: "tuning" | "heldout";
  repeat: number;
  candidates: CachedCandidate[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

interface Cache {
  fixture: string;
  date: string;
  model: string;
  jevQuestionVersion: string;
  runs: CachedRun[];
}

/** The error's class and HTTP status only; messages and bodies can echo request content. */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${name} (HTTP ${status})` : name;
}

async function collect(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    console.log("TYPESAFE_API_KEY is not set; nothing collected.");
    return;
  }
  const { chunks } = await loadChunks(join(FIXTURES, FIXTURE));
  const runs: CachedRun[] = [];
  const provider = new JevDecisionProvider();
  for (const task of await loadLabeledTasks(FIXTURE)) {
    const { candidates, ranking } = selectCandidates(task.task, chunks);
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      try {
        const decision = await provider.decide({ task: task.task, candidates });
        const relevance = validateJudgments(candidates, decision.judgments);
        runs.push({
          taskId: task.id,
          split: task.split,
          repeat,
          candidates: candidates.map((chunk) => ({
            id: chunk.id,
            relevance: relevance.get(chunk.id)!,
            deterministic: ranking.get(chunk.id)?.total ?? 0,
          })),
          ...(decision.usage
            ? { inputTokens: decision.usage.inputTokens, outputTokens: decision.usage.outputTokens }
            : {}),
          ...(decision.latencyMs === undefined ? {} : { latencyMs: decision.latencyMs }),
        });
        console.log(`${task.id} run ${repeat}: ${candidates.length} candidates judged`);
      } catch (error) {
        console.log(`${task.id} run ${repeat}: failed, ${describeError(error)}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  const cache: Cache = {
    fixture: FIXTURE,
    date: new Date().toISOString().slice(0, 10),
    model: jevModel(),
    jevQuestionVersion: JEV_QUESTION_VERSION,
    runs,
  };
  await writeFile(CACHE, `${JSON.stringify(cache, null, 1)}\n`);
  const sum = (key: "inputTokens" | "outputTokens") => runs.reduce((total, run) => total + (run[key] ?? 0), 0);
  console.log(
    `wrote ${runs.length} runs; ${sum("inputTokens")} input and ${sum("outputTokens")} output tokens in total`,
  );
}

interface Prepared {
  chunkMap: Map<string, CodeChunk>;
  charsById: Map<string, number>;
  tasks: Map<string, LabeledTask>;
  required: Map<string, string[][]>;
  useful: Map<string, Set<string>>;
  irrelevant: Map<string, Set<string>>;
}

async function prepare(): Promise<Prepared> {
  const { chunks } = await loadChunks(join(FIXTURES, FIXTURE));
  const tasks = await loadLabeledTasks(FIXTURE);
  const ids = (labels: string[]) => labels.flatMap((label) => resolve(label, chunks).map((chunk) => chunk.id));
  return {
    chunkMap: new Map(chunks.map((chunk) => [chunk.id, chunk])),
    charsById: new Map(chunks.map((chunk) => [chunk.id, chunk.content.length])),
    tasks: new Map(tasks.map((task) => [task.id, task])),
    required: new Map(tasks.map((t) => [t.id, t.required.map((label) => resolve(label, chunks).map((c) => c.id))])),
    useful: new Map(tasks.map((t) => [t.id, new Set(ids(t.useful))])),
    irrelevant: new Map(tasks.map((t) => [t.id, new Set(ids(t.irrelevant))])),
  };
}

/** Selects with the real selector (supports included) from the given scores, one per cached candidate. */
function select(prep: Prepared, run: CachedRun, scores: readonly number[], minScore: number): Set<string> {
  const scored: SelectedChunk[] = run.candidates.map((candidate, i) => {
    const chunk = prep.chunkMap.get(candidate.id);
    if (!chunk) throw new Error(`Cached chunk ${candidate.id} no longer exists; re-run with --collect.`);
    return { chunk, signals: {}, score: scores[i]!, reason: "sweep" };
  });
  const result = selectByRelevance(scored, { task: "", mode: "jev", chunks: prep.chunkMap, minScore });
  return new Set(result.chunks.map((item) => item.chunk.id));
}

function evaluate(prep: Prepared, run: CachedRun, scores: readonly number[], minScore: number): SelectionEvaluation {
  const baseline = select(
    prep,
    run,
    run.candidates.map(() => 1),
    MIN_RELEVANCE,
  );
  const baselineChars = [...baseline].reduce((sum, id) => sum + (prep.charsById.get(id) ?? 0), 0);
  return evaluateSelection({
    selectedIds: select(prep, run, scores, minScore),
    required: prep.required.get(run.taskId)!,
    usefulIds: prep.useful.get(run.taskId)!,
    irrelevantIds: prep.irrelevant.get(run.taskId)!,
    charsById: prep.charsById,
    baselineChars,
  });
}

const fmt = (s: Summary | undefined, digits = 2, pct = false) => {
  if (!s) return "n/a";
  const f = (v: number) => (pct ? `${(100 * v).toFixed(0)}%` : v.toFixed(digits));
  return s.min === s.max ? f(s.mean) : `${f(s.mean)} (${f(s.min)}-${f(s.max)})`;
};

function row(evals: SelectionEvaluation[]): string[] {
  return [
    fmt(summarize(evals.map((e) => e.recall)), 2, true),
    fmt(summarize(evals.map((e) => e.usefulRecall)), 2, true),
    fmt(summarize(evals.map((e) => e.precision)), 2, true),
    fmt(summarize(evals.map((e) => e.irrelevantSelected)), 1),
    fmt(summarize(evals.map((e) => e.unlabeledSelected)), 1),
    fmt(summarize(evals.map((e) => e.selectedCount)), 1),
    fmt(summarize(evals.map((e) => e.sizeReduction)), 2, true),
  ];
}

const HEADER = [
  "required recall",
  "useful recall",
  "precision",
  "irrelevant",
  "unlabeled",
  "selected",
  "size reduction",
];
function table(first: string, rows: [string, string[]][]): void {
  console.log(`| ${[first, ...HEADER].join(" | ")} |`);
  console.log(`|${[first, ...HEADER].map(() => "---").join("|")}|`);
  for (const [label, cells] of rows) console.log(`| ${[label, ...cells].join(" | ")} |`);
  console.log("");
}

async function sweep(): Promise<void> {
  const cache = JSON.parse(await readFile(CACHE, "utf8")) as Cache;
  const prep = await prepare();
  const argIndex = process.argv.indexOf("--threshold");
  const chosen = argIndex < 0 ? MIN_RELEVANCE : Number(process.argv[argIndex + 1]);
  console.log(
    `Cache: ${cache.fixture}, ${cache.runs.length} runs, ${cache.date}, model ${cache.model}, ${cache.jevQuestionVersion}\n`,
  );
  const thresholds = Array.from({ length: 11 }, (_, i) => Math.round((0.3 + 0.05 * i) * 100) / 100);
  const jevScores = (run: CachedRun) => run.candidates.map((c) => c.relevance);

  for (const split of ["tuning", "heldout"] as const) {
    const runs = cache.runs.filter((run) => run.split === split);
    console.log(`## Threshold sweep, ${split} (${runs.length} runs)\n`);
    table(
      "threshold",
      thresholds.map((t) => [t.toFixed(2), row(runs.map((run) => evaluate(prep, run, jevScores(run), t)))]),
    );
  }

  console.log("## Candidates whose relevance varies between repeats (spread of at least 0.1)\n");
  console.log("| task | chunk | label | relevance per repeat |\n|---|---|---|---|");
  for (const [taskId, task] of prep.tasks) {
    const runs = cache.runs.filter((run) => run.taskId === taskId);
    for (const [i, candidate] of (runs[0]?.candidates ?? []).entries()) {
      const values = runs.map((run) => run.candidates[i]!.relevance);
      if (Math.max(...values) - Math.min(...values) < 0.1) continue;
      const label =
        task.required.length && prep.required.get(taskId)!.some((ids) => ids.includes(candidate.id))
          ? "required"
          : prep.useful.get(taskId)!.has(candidate.id)
            ? "useful"
            : prep.irrelevant.get(taskId)!.has(candidate.id)
              ? "irrelevant"
              : "unlabeled";
      console.log(`| ${taskId} | ${candidate.id} | ${label} | ${values.map((v) => v.toFixed(2)).join(", ")} |`);
    }
  }
  console.log("");

  const heldout = cache.runs.filter((run) => run.split === "heldout");
  const neighborhood = [-0.1, -0.05, 0, 0.05, 0.1].map((d) => Math.round((chosen + d) * 100) / 100);
  console.log(`## Blending on held-out (final = jev + w * deterministic / max deterministic)\n`);
  const rows: [string, string[]][] = [];
  for (const t of neighborhood) {
    for (const w of [0, 0.05, 0.1, 0.2]) {
      const evals = heldout.map((run) =>
        evaluate(
          prep,
          run,
          blendScores(
            jevScores(run),
            run.candidates.map((c) => c.deterministic),
            w,
          ),
          t,
        ),
      );
      rows.push([`${t.toFixed(2)} / w=${w}`, row(evals)]);
    }
  }
  table("threshold / weight", rows);

  const total = (key: "inputTokens" | "outputTokens") => cache.runs.reduce((sum, run) => sum + (run[key] ?? 0), 0);
  const latency = summarize(cache.runs.map((run) => run.latencyMs));
  console.log(
    `Usage in the cache: ${total("inputTokens")} input and ${total("outputTokens")} output tokens, latency ${fmt(latency, 0)} ms`,
  );
}

if (process.argv.includes("--collect")) await collect();
else await sweep();
