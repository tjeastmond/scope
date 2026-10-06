import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeRegions, toScopeRegion } from "../src/context/regions.ts";
import { FORMATS, renderFormat, type OutputFormat } from "../src/output/index.ts";
import type { CodeChunk, ScopeResult, SelectedChunk } from "../src/types.ts";
import { runScope } from "../src/scope.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { loadLabeledTasks } from "./helpers/labels.ts";

/**
 * Golden files pin the exact bytes of each format for one hand-built result that exercises every section: summary,
 * regions, over-budget skips (more than the listing cap), below-threshold skips and unmet coherence. Regenerate with
 * `UPDATE_GOLDEN=1 bun test tests/golden.test.ts` and review the diff.
 */
const DIR = join(import.meta.dir, "golden");
const EXTENSIONS: Record<OutputFormat, string> = { text: "txt", markdown: "md", json: "json" };

const chunk = (id: string, name: string, startLine: number, endLine: number, content: string): CodeChunk => ({
  id,
  file: "src/invoices.ts",
  language: "typescript",
  kind: "function",
  name,
  startLine,
  endLine,
  content,
  references: [],
  estimatedTokens: 10,
});
const pick = (c: CodeChunk, relevance: number | undefined, score: number): SelectedChunk => ({
  chunk: c,
  signals: {},
  relevance,
  score,
  reason: "golden",
});

const total = chunk(
  "src/invoices.ts#total",
  "total",
  3,
  5,
  "function total(a: number, b: number) {\n  return a + b;\n}",
);
const due = chunk("src/invoices.ts#due", "due", 7, 9, "function due(day: string) {\n  return day;\n}");

const skip = (n: number, reason: "over-budget" | "below-threshold") => ({
  chunkId: `src/big.ts#big${n}`,
  file: "src/big.ts",
  startLine: n * 10,
  endLine: n * 10 + 5,
  name: `big${n}`,
  ...(reason === "over-budget" ? { relevance: 0.9 - n / 100 } : {}),
  score: 0.5,
  estimatedTokens: 100 + n,
  reason,
  ...(reason === "over-budget" ? { minimumBudget: 400 + n } : {}),
});

const result: ScopeResult = {
  schemaVersion: 1,
  mode: "jev",
  task: "Validate invoice totals",
  budget: 900,
  estimator: "scope-heuristic-v1",
  estimatedTokens: 312,
  characters: 1100,
  lines: 40,
  chunks: [pick(total, 0.91, 0.91), pick(due, undefined, 0.4)],
  regions: [
    {
      file: "src/invoices.ts",
      language: "typescript",
      startLine: 3,
      endLine: 9,
      content: [total.content, "", due.content].join("\n"),
      chunkIds: [total.id, due.id],
    },
  ],
  warnings: ["7 relevant chunk(s) were left out to stay within the budget."],
  unmetCoherence: [
    { chunkId: total.id, requiredId: "src/types.ts#Money", reason: "too-large" },
    { chunkId: due.id, requiredId: "src/big.ts#big1", reason: "over-budget" },
  ],
  skipped: [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => skip(n, "over-budget")),
    ...[8, 9].map((n) => skip(n, "below-threshold")),
  ],
  retrievalConfigVersion: "golden-1",
};

test.each([...FORMATS])("the %s format matches its golden file", async (format) => {
  const file = join(DIR, `result.${EXTENSIONS[format]}`);
  const actual = renderFormat(format, result);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, actual);
  }
  expect(actual).toBe(await readFile(file, "utf8"));
});

/** `--explain` on the same result, with signals, origins and a supporting declaration to explain. */
const explainedChunks: SelectedChunk[] = [
  { ...pick(total, 0.91, 0.91), signals: { symbol: 0.5, lexical: 0.25, path: 0.2 }, origin: "direct" },
  { ...pick(due, 0.6, 0.6), signals: { dependency: 1 }, origin: `expanded-from:${total.id}` },
  {
    chunk: chunk("src/invoices.ts#Money", "Money", 1, 1, "type Money = number;"),
    signals: {},
    score: 0,
    reason: "Supporting declaration for total",
    supportFor: [total.id],
  },
];
const explained: ScopeResult = {
  ...result,
  chunks: explainedChunks,
  regions: mergeRegions(explainedChunks).map(toScopeRegion),
  explain: true,
};

test.each([...FORMATS])("the %s format with --explain matches its golden file", async (format) => {
  const file = join(DIR, `result.explain.${EXTENSIONS[format]}`);
  const actual = renderFormat(format, explained);
  if (process.env.UPDATE_GOLDEN === "1") await writeFile(file, actual);
  expect(actual).toBe(await readFile(file, "utf8"));
});

/** The same three formats on the real mixed-app fixture: a fake provider judges the due-date task's labeled chunks. */
const fixtureTask = (await loadLabeledTasks("mixed-app")).find((task) => task.id === "due-date-column")!;
const judged: Record<string, number> = {};
for (const label of fixtureTask.required) judged[label.split("::")[1]!] = 0.95;
for (const label of fixtureTask.useful) judged[label.split("::")[1]!] = 0.7;

test.each([...FORMATS])("the %s format on the mixed fixture matches its golden file", async (format) => {
  const file = join(DIR, `mixed-app.${EXTENSIONS[format]}`);
  const { result: run } = await runScope({
    task: fixtureTask.task,
    repo: join(import.meta.dir, "../fixtures/mixed-app"),
    provider: fakeProvider({ relevance: judged, fallback: 0.1 }),
    budget: 8000,
    format,
  });
  const actual = renderFormat(format, run);
  if (process.env.UPDATE_GOLDEN === "1") await writeFile(file, actual);
  expect(actual).toBe(await readFile(file, "utf8"));
  expect(run.estimatedTokens).toBeLessThanOrEqual(run.budget);
});
