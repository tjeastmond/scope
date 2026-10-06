import { expect, test } from "bun:test";
import { join } from "node:path";
import { MAX_SUPPORT_TOKENS } from "../src/config.ts";
import { BudgetTooSmallError, selectWithinBudget } from "../src/context/select.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { renderResult } from "../src/output/text.ts";
import { renderText } from "./helpers/render.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk, SelectedChunk } from "../src/types.ts";

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

test("drops candidates below the minimum relevance", () => {
  const result = selectWithinBudget([item("a", 0.9, body(40)), item("b", 0.49, body(40))], { ...base, budget: 1000 });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["a"]);
});

test("includes the best score-per-token first and never exceeds the budget", () => {
  const candidates = [item("big", 0.95, body(800)), item("small1", 0.8, body(80)), item("small2", 0.8, body(80))];
  const result = selectWithinBudget(candidates, { ...base, budget: 220 });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["small1", "small2"]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(220);
  expect(result.warnings[0]).toContain("1 relevant chunk(s)");
});

test("ranks by score per token, not by raw score, when only one candidate fits", () => {
  const candidates = [item("long", 0.9, body(200)), item("short", 0.6, body(40))];
  const result = selectWithinBudget(candidates, { ...base, budget: 160 });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["short"]);
});

test("the measured full output fits the budget and matches the reported estimate", () => {
  const candidates = Array.from({ length: 10 }, (_unused, i) => item(`c${i}`, 0.6 + i / 100, body(60 + i * 7)));
  const result = selectWithinBudget(candidates, { ...base, budget: 600 });
  const text = renderResult(result);
  expect(heuristicEstimator.count(text)).toBeLessThanOrEqual(600);
  expect(result.estimatedTokens).toBe(heuristicEstimator.count(text));
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
    selectWithinBudget(input, { ...base, budget: 200 }).chunks.map((x) => x.chunk.id);
  expect(tight([c, b, a])).toEqual(tight([a, b, c]));
});

test("prints exact path:start-end locations followed by the source lines", () => {
  const code = "function f() {\n  return 1;\n}";
  const result = selectWithinBudget([item("f", 0.9, code, "src/f.ts", 10)], { ...base, budget: 1000 });
  const text = renderResult(result);
  expect(text).toContain("== src/f.ts:10-12 f (relevance 0.90) ==\nfunction f() {\n  return 1;\n}\n");
});

test("nothing relevant is an empty artifact; a relevant chunk that cannot fit fails naming the minimum budget", () => {
  const empty = selectWithinBudget([item("a", 0.2, body(10))], { ...base, budget: 1000 });
  expect(empty.chunks).toEqual([]);
  expect(empty.skipped.map((skip) => skip.reason)).toEqual(["below-threshold"]);
  expect(empty.warnings).toEqual([
    expect.stringMatching(/^No relevant chunks found: no candidate scored at least 0.5/),
  ]);
  expect(() => selectWithinBudget([item("a", 0.9, body(4000))], { ...base, budget: 100 })).toThrow(BudgetTooSmallError);
  expect(() => selectWithinBudget([item("a", 0.9, body(4000))], { ...base, budget: 100 })).toThrow(
    /--budget must be at least \d+/,
  );
});

// Coherence: supporting declarations pulled in next to a selected chunk.

const asChunk = (entry: SelectedChunk): CodeChunk => entry.chunk;
const lookupOf = (...chunks: CodeChunk[]) => new Map(chunks.map((c) => [c.id, c]));
const cost = (...entries: SelectedChunk[]) => heuristicEstimator.count(renderText("do it", entries));
/** Phase 1 reserves the embedded size numbers at their widest, so a budget equal to a measured cost needs a little room. */
const SLACK = 8;
const supportOf = (chunk: CodeChunk, supportFor: string[] = []): SelectedChunk => ({
  chunk,
  signals: {},
  score: 0,
  reason: "",
  supportFor,
});

/** A class header chunk and one method of it; the method is the candidate, the header is not. */
function classWithMethod(headerBody: number, score = 0.9, methodBody = 60) {
  const header = item("Cls", 1, body(headerBody), "cls.ts", 1).chunk;
  header.kind = "class";
  const method = item("Cls.run", score, body(methodBody), "cls.ts", 10);
  method.chunk.kind = "method";
  method.chunk.parentId = "Cls";
  return { header, method };
}

test("a selected method pulls in its class header, charged against the budget", () => {
  const { header, method } = classWithMethod(80);
  const needed = cost(supportOf(header), method);
  expect(needed).toBeGreaterThan(cost(method));

  const result = selectWithinBudget([method], {
    ...base,
    budget: needed + SLACK,
    chunks: lookupOf(header, asChunk(method)),
  });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(needed + SLACK);
  expect(heuristicEstimator.count(renderResult(result))).toBe(result.estimatedTokens);
  expect(result.unmetCoherence).toEqual([]);
  expect(result.warnings).toEqual([]);

  const [support, selected] = result.chunks;
  expect(support?.relevance).toBeUndefined();
  expect(support?.score).toBe(0);
  expect(support?.signals).toEqual({});
  expect(support?.supportFor).toEqual(["Cls.run"]);
  expect(support?.reason).toBe("Supporting declaration for Cls.run");
  expect(selected?.supportFor).toBeUndefined();
  const text = renderResult(result);
  expect(text).toContain("(supporting declaration) ==");
  expect(text).toContain("(relevance 0.90)");
});

test("a support that does not fit with the chunk is unmet over-budget while the chunk stays", () => {
  const { header, method } = classWithMethod(80);
  const budget = cost(supportOf(header), method) - 1;
  expect(budget).toBeGreaterThanOrEqual(cost(method));
  const result = selectWithinBudget([method], { ...base, budget, chunks: lookupOf(header, asChunk(method)) });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls.run"]);
  expect(result.unmetCoherence).toEqual([{ chunkId: "Cls.run", requiredId: "Cls", reason: "over-budget" }]);
  expect(result.warnings).toEqual(["1 coherence requirement(s) could not be included; see unmetCoherence."]);
});

test("a support above the cheap cap is unmet too-large even with a huge budget", () => {
  const { header, method } = classWithMethod(MAX_SUPPORT_TOKENS * 4);
  expect(heuristicEstimator.count(header.content)).toBeGreaterThan(MAX_SUPPORT_TOKENS);
  const result = selectWithinBudget([method], { ...base, budget: 100_000, chunks: lookupOf(header, asChunk(method)) });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls.run"]);
  expect(result.unmetCoherence).toEqual([{ chunkId: "Cls.run", requiredId: "Cls", reason: "too-large" }]);
});

test("a support exactly at the cap is pulled in", () => {
  let size = MAX_SUPPORT_TOKENS * 3;
  const { header, method } = classWithMethod(size);
  while (heuristicEstimator.count(header.content) > MAX_SUPPORT_TOKENS) header.content = body(--size);
  expect(heuristicEstimator.count(header.content)).toBe(MAX_SUPPORT_TOKENS);
  const result = selectWithinBudget([method], { ...base, budget: 100_000, chunks: lookupOf(header, asChunk(method)) });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
});

test("a shared header is included once and lists every chunk that needs it", () => {
  const { header, method } = classWithMethod(60);
  const other = item("Cls.other", 0.8, body(60), "cls.ts", 20);
  other.chunk.kind = "method";
  other.chunk.parentId = "Cls";
  const chunks = lookupOf(header, asChunk(method), asChunk(other));
  const result = selectWithinBudget([method, other], { ...base, budget: 100_000, chunks });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run", "Cls.other"]);
  expect(result.chunks[0]?.supportFor).toEqual(["Cls.other", "Cls.run"]);
  expect(result.chunks[0]?.reason).toBe("Supporting declaration for Cls.other, Cls.run");
});

test("a support that is also a selected candidate is not duplicated and keeps its own relevance", () => {
  const { header, method } = classWithMethod(60);
  const candidate = { ...item("Cls", 0.95, header.content, "cls.ts", 1), chunk: header };
  for (const order of [
    [method, candidate],
    [candidate, method],
  ]) {
    const result = selectWithinBudget(order, { ...base, budget: 100_000, chunks: lookupOf(header, asChunk(method)) });
    expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
    expect(result.chunks[0]?.relevance).toBe(0.95);
    expect(result.chunks[0]?.supportFor).toBeUndefined();
    expect(result.unmetCoherence).toEqual([]);
  }
});

test("a support pulled in first is upgraded when its own turn comes", () => {
  // The short, dense method is processed first, so the long header is pulled in as a support and only then judged.
  const { header, method } = classWithMethod(300, 0.9, 20);
  const candidate = { ...item("Cls", 0.55, header.content, "cls.ts", 1), chunk: header };
  const result = selectWithinBudget([candidate, method], {
    ...base,
    budget: 100_000,
    chunks: lookupOf(header, asChunk(method)),
  });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
  expect(result.chunks[0]?.relevance).toBe(0.55);
  expect(result.chunks[0]?.supportFor).toBeUndefined();
  expect(renderResult(result)).toContain("(relevance 0.55)");
});

test("an upgraded support still pulls in the supports it needs itself", () => {
  // The dense method pulls in its class header; the header is then judged and must bring in the class it extends.
  const { header, method } = classWithMethod(60, 0.9, 20);
  const base2 = item("Base", 1, body(40), "base.ts", 1).chunk;
  base2.kind = "class";
  header.references = [
    { kind: "extends", from: { file: "cls.ts", line: 1 }, name: "Base", targetChunkId: "Base", evidence: "exact" },
  ];
  const candidate = { ...item("Cls", 0.55, header.content, "cls.ts", 1), chunk: header };
  const result = selectWithinBudget([candidate, method], {
    ...base,
    budget: 100_000,
    chunks: lookupOf(header, base2, asChunk(method)),
  });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Base", "Cls", "Cls.run"]);
  expect(result.chunks.find((c) => c.chunk.id === "Cls")?.relevance).toBe(0.55);
  expect(result.unmetCoherence).toEqual([]);
});

test("a support below the minimum score is still pulled in as context", () => {
  const { header, method } = classWithMethod(60);
  const weak = { ...item("Cls", 0.1, header.content, "cls.ts", 1), chunk: header };
  const chunks = lookupOf(header, asChunk(method));
  const result = selectWithinBudget([method, weak], { ...base, budget: 100_000, chunks });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
  expect(result.chunks[0]?.relevance).toBeUndefined();
  expect(result.chunks[0]?.supportFor).toEqual(["Cls.run"]);
});

test("exact type references pull in the declaration; heuristic ones do not", () => {
  const alias = item("Alias", 1, body(40), "types.ts", 1).chunk;
  alias.kind = "type";
  const user = item("use", 0.9, body(60), "use.ts", 1);
  const reference = (evidence: "exact" | "heuristic") => ({
    kind: "type" as const,
    from: { file: "use.ts", line: 1 },
    name: "Alias",
    targetChunkId: "Alias",
    evidence,
  });
  const chunks = lookupOf(alias, asChunk(user));
  const ids = () => selectWithinBudget([user], { ...base, budget: 100_000, chunks }).chunks.map((c) => c.chunk.id);
  user.chunk.references = [reference("exact")];
  expect(ids()).toEqual(["Alias", "use"]);
  user.chunk.references = [reference("heuristic")];
  expect(ids()).toEqual(["use"]);
});

test("coherence output is identical regardless of candidate input order", () => {
  const { header, method } = classWithMethod(60);
  const other = item("Cls.other", 0.8, body(60), "cls.ts", 20);
  other.chunk.kind = "method";
  other.chunk.parentId = "Cls";
  const lone = item("lone", 0.7, body(50), "lone.ts", 1);
  const chunks = lookupOf(header, asChunk(method), asChunk(other), asChunk(lone));
  for (const budget of [60, 100, 160, 100_000]) {
    const run = (input: SelectedChunk[]) => {
      try {
        return selectWithinBudget(input, { ...base, budget, chunks });
      } catch (error) {
        return String(error);
      }
    };
    const forward = run([method, other, lone]);
    expect(run([lone, other, method])).toEqual(forward);
    expect(run([other, lone, method])).toEqual(forward);
  }
});

test("unmet requirements are sorted by chunk then required id", () => {
  const big = (id: string) => {
    const chunk = item(id, 1, body(MAX_SUPPORT_TOKENS * 4), `${id}.ts`, 1).chunk;
    chunk.kind = "interface";
    return chunk;
  };
  const [zeta, alpha] = [big("zeta"), big("alpha")] as [CodeChunk, CodeChunk];
  const make = (id: string) => {
    const entry = item(id, 0.9, body(30), `${id}.ts`, 50);
    entry.chunk.references = [zeta, alpha].map((target) => ({
      kind: "type" as const,
      from: { file: `${id}.ts`, line: 50 },
      name: target.id,
      targetChunkId: target.id,
      evidence: "exact" as const,
    }));
    return entry;
  };
  const [b, a] = [make("b"), make("a")] as [SelectedChunk, SelectedChunk];
  const chunks = lookupOf(zeta, alpha, asChunk(a), asChunk(b));
  const result = selectWithinBudget([b, a], { ...base, budget: 100_000, chunks });
  expect(result.unmetCoherence.map((u) => `${u.chunkId}>${u.requiredId}`)).toEqual([
    "a>alpha",
    "a>zeta",
    "b>alpha",
    "b>zeta",
  ]);
});

test("a real method pulls in its class header from the mixed-app fixture", async () => {
  const { chunks } = await loadChunks(join(import.meta.dir, "../fixtures/mixed-app"));
  const file = "api/src/services/invoiceService.ts";
  const method = chunks.find((c) => c.file === file && c.name === "InvoiceService.markPaid")!;
  const header = chunks.find((c) => c.file === file && c.name === "InvoiceService")!;
  expect(method.parentId).toBe(header.id);
  const entry: SelectedChunk = { chunk: method, signals: {}, relevance: 0.9, score: 0.9, reason: "test" };
  const result = selectWithinBudget([entry], { ...base, budget: 8000, chunks: lookupOf(...chunks) });
  expect(result.chunks.map((c) => c.chunk.name)).toEqual(["InvoiceService", "InvoiceService.markPaid"]);
  expect(result.chunks[0]?.supportFor).toEqual([method.id]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(8000);
  expect(result.unmetCoherence).toEqual([]);
});

test("the Unmet coherence section recorded so far is reserved, so a later chunk cannot crowd out the one that needs it", () => {
  // The method's class header is too large to include, which adds an "Unmet coherence" section to the artifact. A
  // bigger, more relevant chunk considered afterwards must be refused up front (the section is reserved), rather than
  // admitted and then winning the prune over the method.
  const { header, method } = classWithMethod(MAX_SUPPORT_TOKENS * 8, 0.6, 40);
  const bigger = item("big", 0.9, body(600), "big.ts");
  const chunks = lookupOf(header, asChunk(method), asChunk(bigger));
  const result = selectWithinBudget([method, bigger], { ...base, budget: 320, chunks });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls.run"]);
  expect(result.unmetCoherence).toEqual([{ chunkId: "Cls.run", requiredId: "Cls", reason: "too-large" }]);
  expect(result.skipped.map((s) => [s.chunkId, s.reason])).toEqual([["big", "over-budget"]]);
  expect(result.estimatedTokens).toBeLessThanOrEqual(320);
});

test("the minimum-budget search gives up at its limit instead of probing beyond it", () => {
  const huge = { id: "huge", count: () => 2 ** 40 + 1 };
  const thrown = (() => {
    try {
      selectWithinBudget([item("a", 0.9, body(10))], { ...base, estimator: huge, budget: 100 });
    } catch (error) {
      return error as Error;
    }
  })();
  expect(thrown).toBeInstanceOf(BudgetTooSmallError);
  expect(thrown?.message).not.toContain("--budget must be at least");
});
