import { expect, test } from "bun:test";
import { join } from "node:path";
import { mergeRegions, toScopeRegion } from "../src/context/regions.ts";
import { selectWithinBudget } from "../src/context/select.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { renderResult } from "../src/output/text.ts";
import { renderText } from "./helpers/render.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk, SelectedChunk } from "../src/types.ts";

/** A chunk made of lines `start..end` (1-based, inclusive) of `source`, split on "\n" only. */
function slice(
  id: string,
  source: string,
  start: number,
  end: number,
  options: { file?: string; relevance?: number; name?: string | null } = {},
): SelectedChunk {
  const { file = "a.ts", relevance = 0.9, name = id } = options;
  const content = source
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
  const chunk: CodeChunk = {
    id,
    file,
    language: "typescript",
    kind: "function",
    startLine: start,
    endLine: end,
    content,
    references: [],
    estimatedTokens: heuristicEstimator.count(content),
  };
  if (name !== null) chunk.name = name;
  return { chunk, signals: {}, relevance, score: relevance, reason: "test" };
}

const SOURCE = Array.from({ length: 12 }, (_unused, i) => `line ${i + 1}`).join("\n");
const range = (r: { startLine: number; endLine: number }) => [r.startLine, r.endLine];
const ids = (r: { chunks: SelectedChunk[] }) => r.chunks.map((c) => c.chunk.id);

test("disjoint chunks stay separate regions, a gap of exactly one line included", () => {
  const regions = mergeRegions([slice("a", SOURCE, 1, 3), slice("b", SOURCE, 5, 6), slice("c", SOURCE, 9, 10)]);
  expect(regions.map(range)).toEqual([
    [1, 3],
    [5, 6],
    [9, 10],
  ]);
});

test("adjacent chunks (end + 1 == start) merge into one region", () => {
  const [region, ...rest] = mergeRegions([slice("a", SOURCE, 1, 3), slice("b", SOURCE, 4, 6)]);
  expect(rest).toEqual([]);
  expect(range(region!)).toEqual([1, 6]);
  expect(region!.content).toBe(SOURCE.split("\n").slice(0, 6).join("\n"));
  expect(ids(region!)).toEqual(["a", "b"]);
});

test("overlapping chunks merge and each shared line appears once", () => {
  const [region, ...rest] = mergeRegions([slice("a", SOURCE, 1, 5), slice("b", SOURCE, 4, 8)]);
  expect(rest).toEqual([]);
  expect(range(region!)).toEqual([1, 8]);
  expect(region!.content).toBe(SOURCE.split("\n").slice(0, 8).join("\n"));
});

test("a nested child pays once: the region equals the parent and keeps both ids", () => {
  const parent = slice("parent", SOURCE, 2, 10);
  const [region, ...rest] = mergeRegions([slice("child", SOURCE, 4, 6), parent]);
  expect(rest).toEqual([]);
  expect(region!.content).toBe(parent.chunk.content);
  expect(range(region!)).toEqual([2, 10]);
  expect(ids(region!)).toEqual(["parent", "child"]);
});

test("a chain of three chunks merges into one region", () => {
  const [region, ...rest] = mergeRegions([
    slice("c", SOURCE, 7, 9),
    slice("a", SOURCE, 1, 3),
    slice("b", SOURCE, 3, 7),
  ]);
  expect(rest).toEqual([]);
  expect(range(region!)).toEqual([1, 9]);
  expect(ids(region!)).toEqual(["a", "b", "c"]);
});

test("the same lines in two files stay separate and regions sort by file", () => {
  const regions = mergeRegions([
    slice("b", SOURCE, 1, 3, { file: "b.ts" }),
    slice("a", SOURCE, 1, 3, { file: "a.ts" }),
  ]);
  expect(regions.map((r) => r.file)).toEqual(["a.ts", "b.ts"]);
  expect(regions.map(ids)).toEqual([["a"], ["b"]]);
});

test("the result does not depend on input order", () => {
  const input = [
    slice("a", SOURCE, 1, 3),
    slice("b", SOURCE, 4, 6),
    slice("c", SOURCE, 9, 10),
    slice("d", SOURCE, 2, 2),
  ];
  expect(mergeRegions([...input].reverse())).toEqual(mergeRegions(input));
  expect(mergeRegions([input[2]!, input[0]!, input[3]!, input[1]!])).toEqual(mergeRegions(input));
});

test("content is exact for CRLF and Unicode: the union equals the source slice", () => {
  const source = [
    "const a = 1;\r",
    'const π = "héllo \u{1F600}";\r',
    "  \t",
    "",
    "const b = 2;\r",
    "// trailing  ",
  ].join("\n");
  const [region, ...rest] = mergeRegions([
    slice("x", source, 1, 3),
    slice("y", source, 3, 5),
    slice("z", source, 6, 6),
  ]);
  expect(rest).toEqual([]);
  expect(region!.content).toBe(source);
  expect(region!.content).toContain("\r\n");
});

test("when chunks disagree about a line the first in sorted order wins", () => {
  const first = slice("a", SOURCE, 1, 3);
  const second = slice("b", SOURCE, 2, 4);
  second.chunk.content = "second 2\nsecond 3\nsecond 4";
  const [region] = mergeRegions([second, first]);
  expect(region!.content).toBe("line 1\nline 2\nline 3\nsecond 4");
});

test("provenance is sorted by start line then id, and the serializable form lists ids", () => {
  const [region] = mergeRegions([slice("z", SOURCE, 3, 4), slice("m", SOURCE, 1, 3), slice("a", SOURCE, 1, 3)]);
  expect(ids(region!)).toEqual(["a", "m", "z"]);
  expect(toScopeRegion(region!)).toEqual({
    file: "a.ts",
    language: "typescript",
    startLine: 1,
    endLine: 4,
    content: "line 1\nline 2\nline 3\nline 4",
    chunkIds: ["a", "m", "z"],
  });
});

test("adjacent and overlapping slices of a real mixed-app chunk merge back into the original", async () => {
  const { chunks } = await loadChunks(join(import.meta.dir, "../fixtures/mixed-app"));
  const real = chunks.filter((c) => c.endLine - c.startLine >= 5).sort((a, b) => a.id.localeCompare(b.id))[0]!;
  const padded = `${"\n".repeat(real.startLine - 1)}${real.content}`;
  const part = (id: string, from: number, to: number) => slice(id, padded, from, to, { file: real.file });
  const mid = real.startLine + 2;
  const adjacent = mergeRegions([part("top", real.startLine, mid), part("rest", mid + 1, real.endLine)]);
  const overlapping = mergeRegions([part("top", real.startLine, mid + 1), part("rest", mid, real.endLine)]);
  for (const regions of [adjacent, overlapping]) {
    expect(regions).toHaveLength(1);
    expect(regions[0]!.content).toBe(real.content);
    expect(range(regions[0]!)).toEqual([real.startLine, real.endLine]);
  }
});

// Cost on the union.

const textOf = (...entries: SelectedChunk[]) => renderText("do it", entries);
/** Only the region blocks: the header and summary are covered by the format tests. */
const regionsOf = (...entries: SelectedChunk[]) => {
  const text = textOf(...entries);
  return text.slice(text.indexOf("== "));
};
const base = {
  task: "do it",
  mode: "jev" as const,
  estimator: heuristicEstimator,
  chunks: new Map<string, CodeChunk>(),
};
const numbered = (count: number) =>
  Array.from({ length: count }, (_unused, i) => `const value${i} = compute(${i});`).join("\n");

test("overlapping chunks cost less than the sum of their separate renderings", () => {
  const lines = numbered(30);
  const a = slice("a", lines, 1, 20);
  const b = slice("b", lines, 10, 30);
  const merged = heuristicEstimator.count(textOf(a, b));
  const separate = heuristicEstimator.count(textOf(a)) + heuristicEstimator.count(textOf(b));
  expect(merged).toBeLessThan(separate);
  expect(textOf(a, b).match(/const value15 /g)).toHaveLength(1);
});

test("the selector reports the cost of the merged text, with a chosen child recorded and not charged again", () => {
  const lines = numbered(40);
  const parent = slice("parent", lines, 1, 40, { relevance: 0.9 });
  const child = slice("child", lines, 5, 10, { relevance: 0.8 });
  const parentOnly = heuristicEstimator.count(textOf(parent));
  const result = selectWithinBudget([parent, child], { ...base, budget: parentOnly + 40 });
  expect(result.chunks.map((c) => c.chunk.id).sort()).toEqual(["child", "parent"]);
  expect(result.regions).toHaveLength(1);
  expect(result.regions[0]!.chunkIds).toEqual(["parent", "child"]);
  expect(result.regions[0]!.content).toBe(parent.chunk.content);
  const text = renderResult(result);
  expect(result.estimatedTokens).toBe(heuristicEstimator.count(text));
  expect(result.characters).toBe(text.length);
  expect(result.lines).toBe(text.split("\n").length);
  expect(text.match(/^== /gm)).toHaveLength(1);
  expect(text.match(/const value7 /g)).toHaveLength(1);
});

test("separate regions in the result are listed in file and line order", () => {
  const a = slice("a", SOURCE, 1, 2, { file: "z.ts" });
  const b = slice("b", SOURCE, 1, 2, { file: "a.ts" });
  const result = selectWithinBudget([a, b], { ...base, budget: 1000 });
  expect(result.regions.map((r) => r.file)).toEqual(["a.ts", "z.ts"]);
});

// Rendering.

test("a single-chunk region renders exactly as a lone chunk always did", () => {
  const entry = slice("f", "function f() {\n  return 1;\n}", 1, 3, { file: "src/f.ts" });
  expect(regionsOf(entry)).toBe("== src/f.ts:1-3 f (relevance 0.90) ==\nfunction f() {\n  return 1;\n}\n");
  const unnamed = slice("g", SOURCE, 1, 1, { name: null });
  unnamed.relevance = undefined;
  unnamed.score = 1;
  expect(regionsOf(unnamed)).toBe("== a.ts:1-1 (score 1.00) ==\nline 1\n");
  const support = slice("h", SOURCE, 1, 1);
  support.relevance = undefined;
  support.supportFor = ["x"];
  expect(regionsOf(support)).toBe("== a.ts:1-1 h (supporting declaration) ==\nline 1\n");
});

test("a merged region has one header listing every member with its own label", () => {
  const cls = slice("cls", SOURCE, 1, 3, { name: "Cart", relevance: 0.87 });
  const method = slice("m", SOURCE, 4, 6, { name: "Cart.add" });
  method.relevance = undefined;
  method.score = 1;
  const support = slice("s", SOURCE, 7, 8, { name: "Helper" });
  support.relevance = undefined;
  support.supportFor = ["m"];
  expect(regionsOf(support, method, cls)).toBe(
    "== a.ts:1-8 Cart, Cart.add, Helper (Cart relevance 0.87; Cart.add score 1.00; Helper supporting declaration) ==\n" +
      SOURCE.split("\n").slice(0, 8).join("\n") +
      "\n",
  );
});
