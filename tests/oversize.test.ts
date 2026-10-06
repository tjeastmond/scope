import { expect, test } from "bun:test";
import { join } from "node:path";
import { selectWithinBudget } from "../src/context/select.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { renderText } from "../src/output/text.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk, SelectedChunk, TokenEstimator } from "../src/types.ts";

const item = (id: string, score: number, content: string, file = `${id}.ts`, startLine = 1): SelectedChunk => ({
  chunk: {
    id,
    file,
    language: "typescript",
    kind: "function",
    name: id,
    startLine,
    endLine: startLine + content.split("\n").length - 1,
    content,
    references: [],
    estimatedTokens: heuristicEstimator.count(content),
  },
  signals: {},
  relevance: score,
  score,
  reason: "test",
});

const base = {
  task: "do it",
  mode: "jev" as const,
  estimator: heuristicEstimator,
  chunks: new Map<string, CodeChunk>(),
};
const body = (n: number) => "x".repeat(n);
/** Cost of an artifact holding only these chunks. */
const cost = (...entries: SelectedChunk[]) => heuristicEstimator.count(renderText(base.task, entries));
const ids = (result: { chunks: SelectedChunk[] }) => result.chunks.map((c) => c.chunk.id);

test("a chunk larger than the whole budget is skipped, reported with its cost, and the rest is still selected", () => {
  const huge = item("huge", 0.9, body(4000));
  const small = item("small", 0.8, body(40));
  const budget = cost(small) + 10;
  expect(cost(huge)).toBeGreaterThan(budget);

  const result = selectWithinBudget([huge, small], { ...base, budget });
  expect(ids(result)).toEqual(["small"]);
  expect(result.skipped).toEqual([
    {
      chunkId: "huge",
      file: "huge.ts",
      startLine: 1,
      endLine: 1,
      name: "huge",
      relevance: 0.9,
      score: 0.9,
      estimatedTokens: huge.chunk.estimatedTokens,
      reason: "over-budget",
      minimumBudget: cost(huge),
    },
  ]);
  expect(result.skipped[0]!.minimumBudget).toBeGreaterThan(budget);
  expect(result.warnings).toEqual(["1 relevant chunk(s) were left out to stay within the budget."]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
});

test("a chunk that fits whole is included in full and not reported as skipped", () => {
  const fits = item("fits", 0.9, body(200));
  const result = selectWithinBudget([fits], { ...base, budget: cost(fits) + 20 });
  expect(ids(result)).toEqual(["fits"]);
  expect(result.chunks[0]!.chunk.content).toBe(fits.chunk.content);
  expect(result.skipped).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("a budget equal to the minimum budget selects the chunk and one token less skips it", () => {
  const only = item("only", 0.9, body(400));
  const minimum = cost(only);
  const exact = selectWithinBudget([only], { ...base, budget: minimum });
  expect(ids(exact)).toContain("only");
  expect(exact.skipped.find((s) => s.chunkId === "only")).toBeUndefined();

  const below = selectWithinBudget([only, item("tiny", 0.6, body(4))], { ...base, budget: minimum - 1 });
  expect(ids(below)).not.toContain("only");
  const skipped = below.skipped.find((s) => s.chunkId === "only");
  expect(skipped?.reason).toBe("over-budget");
  expect(skipped?.minimumBudget).toBe(minimum);
});

test("a chunk that would fit alone but not with the already chosen ones is skipped over-budget", () => {
  const first = item("first", 0.9, body(200));
  const second = item("second", 0.8, body(200));
  const budget = cost(first) + 5;
  expect(cost(second)).toBeLessThanOrEqual(budget);
  const result = selectWithinBudget([first, second], { ...base, budget });
  expect(ids(result)).toEqual(["first"]);
  expect(result.skipped).toHaveLength(1);
  const [skipped] = result.skipped;
  expect(skipped?.chunkId).toBe("second");
  expect(skipped?.reason).toBe("over-budget");
  expect(skipped!.minimumBudget).toBeLessThanOrEqual(budget);
  expect(result.warnings).toEqual(["1 relevant chunk(s) were left out to stay within the budget."]);
});

test("an oversize chunk ranked first does not starve smaller candidates behind it", () => {
  // The huge chunk has the best score per token, so it is tried first; the greedy loop must move on.
  const huge = item("huge", 1, body(1000));
  const small = item("small", 0.5, body(600));
  const budget = cost(small) + 5;
  expect(cost(huge)).toBeGreaterThan(budget);
  const density = (entry: SelectedChunk) => entry.score / heuristicEstimator.count(entry.chunk.content);
  expect(density(huge)).toBeGreaterThan(density(small));
  const result = selectWithinBudget([huge, small], { ...base, budget });
  expect(ids(result)).toEqual(["small"]);
  expect(result.skipped.map((s) => s.chunkId)).toEqual(["huge"]);
});

test("candidates below the minimum score are recorded as below-threshold without a warning", () => {
  const good = item("good", 0.9, body(40));
  const weak = item("weak", 0.3, body(40));
  const result = selectWithinBudget([good, weak], { ...base, budget: 1000 });
  expect(ids(result)).toEqual(["good"]);
  expect(result.skipped).toEqual([
    {
      chunkId: "weak",
      file: "weak.ts",
      startLine: 1,
      endLine: 1,
      name: "weak",
      relevance: 0.3,
      score: 0.3,
      estimatedTokens: weak.chunk.estimatedTokens,
      reason: "below-threshold",
    },
  ]);
  expect(result.warnings).toEqual([]);
});

test("the warning counts only over-budget skips, not below-threshold ones", () => {
  const result = selectWithinBudget(
    [item("a", 0.9, body(40)), item("big", 0.8, body(4000)), item("w1", 0.1, body(40)), item("w2", 0.2, body(40))],
    { ...base, budget: 100 },
  );
  expect(result.skipped.map((s) => s.reason).sort()).toEqual(["below-threshold", "below-threshold", "over-budget"]);
  expect(result.warnings).toEqual(["1 relevant chunk(s) were left out to stay within the budget."]);
});

test("skipped chunks are sorted by file, start line, then id regardless of input order", () => {
  const mk = (id: string, file: string, line: number, score = 0.1) => item(id, score, body(40), file, line);
  const entries = [
    mk("z", "b.ts", 1),
    mk("y", "a.ts", 20),
    mk("x", "a.ts", 3),
    mk("w", "a.ts", 3),
    mk("v", "a.ts", 100),
  ];
  const keep = item("keep", 0.9, body(40), "c.ts");
  const run = (input: SelectedChunk[]) => selectWithinBudget(input, { ...base, budget: 1000 }).skipped;
  const forward = run([keep, ...entries]);
  expect(forward.map((s) => s.chunkId)).toEqual(["w", "x", "y", "v", "z"]);
  expect(run([...entries].reverse().concat(keep))).toEqual(forward);
});

test("a chunk skipped on its own turn but later included as a support is not reported as skipped", () => {
  // A fake estimator that is not monotonic: the artifact for the header alone looks too big, but it is cheap once the
  // method that needs it is in the artifact. That is how a skipped chunk can end up included as a support.
  const quirky: TokenEstimator = {
    id: "quirky",
    count: (text) => (text.startsWith("Scope context") && !text.includes("needsHeader") ? 1000 : text.length / 4),
  } as TokenEstimator;
  const header = item("Header", 0.9, body(40), "h.ts", 1);
  header.chunk.kind = "class";
  const method = item("needsHeader", 0.6, body(40), "h.ts", 10);
  method.chunk.kind = "method";
  method.chunk.parentId = "Header";
  const chunks = new Map([header, method].map((entry) => [entry.chunk.id, entry.chunk]));

  const result = selectWithinBudget([header, method], { ...base, estimator: quirky, budget: 100, chunks });
  expect(ids(result)).toEqual(["Header", "needsHeader"]);
  expect(result.chunks[0]!.supportFor).toEqual(["needsHeader"]);
  expect(result.skipped).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("the largest real chunk of mixed-app is skipped whole when the budget is below its minimum budget", async () => {
  const { chunks } = await loadChunks(join(import.meta.dir, "../fixtures/mixed-app"));
  const largest = chunks.reduce((a, b) => (b.estimatedTokens > a.estimatedTokens ? b : a));
  const entry: SelectedChunk = { chunk: largest, signals: {}, relevance: 0.9, score: 0.9, reason: "test" };
  const minimum = cost(entry);
  const small = chunks.reduce((a, b) => (b.estimatedTokens < a.estimatedTokens ? b : a));
  const other: SelectedChunk = { chunk: small, signals: {}, relevance: 0.8, score: 0.8, reason: "test" };
  const budget = minimum - 1;
  expect(cost(other)).toBeLessThanOrEqual(budget);

  const result = selectWithinBudget([entry, other], { ...base, budget, chunks: new Map(chunks.map((c) => [c.id, c])) });
  expect(result.chunks.map((c) => c.chunk.id)).not.toContain(largest.id);
  const skipped = result.skipped.find((s) => s.chunkId === largest.id);
  expect(skipped).toMatchObject({
    reason: "over-budget",
    relevance: 0.9,
    estimatedTokens: largest.estimatedTokens,
    file: largest.file,
    startLine: largest.startLine,
    endLine: largest.endLine,
    minimumBudget: minimum,
  });
  expect(
    selectWithinBudget([entry], { ...base, budget: minimum, chunks: new Map(chunks.map((c) => [c.id, c])) }).chunks,
  ).toHaveLength(1);
});
