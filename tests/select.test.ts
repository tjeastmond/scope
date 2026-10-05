import { expect, test } from "bun:test";
import { EmptySelectionError, selectWithinBudget } from "../src/context/select.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import { renderResult } from "../src/output/text.ts";
import type { SelectedChunk } from "../src/types.ts";

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
    estimatedTokens: charsPerTokenEstimator.count(content),
  },
  signals: {},
  relevance: score,
  score,
  reason: "test",
});

const base = { task: "do it", mode: "jev" as const, estimator: charsPerTokenEstimator };
const body = (n: number) => "x".repeat(n);

test("drops candidates below the minimum relevance", () => {
  const result = selectWithinBudget([item("a", 0.9, body(40)), item("b", 0.49, body(40))], { ...base, budget: 1000 });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["a"]);
});

test("includes the best score-per-token first and never exceeds the budget", () => {
  const candidates = [item("big", 0.95, body(800)), item("small1", 0.8, body(80)), item("small2", 0.8, body(80))];
  const result = selectWithinBudget(candidates, { ...base, budget: 120 });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["small1", "small2"]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(120);
  expect(result.warnings[0]).toContain("1 relevant chunk(s)");
});

test("the measured full output fits the budget and matches the reported estimate", () => {
  const candidates = Array.from({ length: 10 }, (_unused, i) => item(`c${i}`, 0.6 + i / 100, body(60 + i * 7)));
  const result = selectWithinBudget(candidates, { ...base, budget: 150 });
  const text = renderResult(result);
  expect(charsPerTokenEstimator.count(text)).toBeLessThanOrEqual(150);
  expect(result.estimatedTokens).toBe(charsPerTokenEstimator.count(text));
  expect(result.characters).toBe(text.length);
});

test("breaks ties deterministically by path, range and ID regardless of input order", () => {
  const a = item("a", 0.8, body(40), "a.ts");
  const b = item("b", 0.8, body(40), "b.ts");
  const c = item("c", 0.8, body(40), "b.ts", 5);
  const first = selectWithinBudget([a, b, c], { ...base, budget: 1000 });
  const second = selectWithinBudget([c, b, a], { ...base, budget: 1000 });
  expect(first.chunks.map((x) => x.chunk.id)).toEqual(["a", "b", "c"]);
  expect(second).toEqual(first);
  const tight = (input: SelectedChunk[]) =>
    selectWithinBudget(input, { ...base, budget: 55 }).chunks.map((x) => x.chunk.id);
  expect(tight([c, b, a])).toEqual(tight([a, b, c]));
});

test("prints exact path:start-end locations followed by the source lines", () => {
  const code = "function f() {\n  return 1;\n}";
  const result = selectWithinBudget([item("f", 0.9, code, "src/f.ts", 10)], { ...base, budget: 1000 });
  const text = renderResult(result);
  expect(text).toContain("== src/f.ts:10-12 f (relevance 0.90) ==\nfunction f() {\n  return 1;\n}\n");
});

test("fails clearly when nothing is relevant or nothing fits", () => {
  expect(() => selectWithinBudget([item("a", 0.2, body(10))], { ...base, budget: 1000 })).toThrow(
    /scored at least 0.5/,
  );
  expect(() => selectWithinBudget([item("a", 0.9, body(4000))], { ...base, budget: 100 })).toThrow(EmptySelectionError);
  expect(() => selectWithinBudget([item("a", 0.9, body(4000))], { ...base, budget: 100 })).toThrow(/--budget/);
});
