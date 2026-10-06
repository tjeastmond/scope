import { expect, test } from "bun:test";
import { join } from "node:path";
import { selectByRelevance } from "../src/context/select.ts";
import { renderResult } from "../src/output/text.ts";
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
  },
  signals: {},
  relevance: score,
  score,
  reason: "test",
});

const base = {
  task: "do it",
  mode: "jev" as const,
  chunks: new Map<string, CodeChunk>(),
};
const body = (n: number) => "x".repeat(n);

test("drops candidates below the minimum relevance", () => {
  const result = selectByRelevance([item("a", 0.9, body(40)), item("b", 0.49, body(40))], base);
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["a"]);
});

test("includes every relevant chunk however much text they total", () => {
  // About 60,000 characters, several times the old 8000-token default; none of it is dropped for size.
  const candidates = Array.from({ length: 30 }, (_unused, i) => item(`c${i}`, 0.6 + i / 100, body(2000 + i)));
  const result = selectByRelevance(candidates, base);
  expect(renderResult(result).length).toBeGreaterThan(60_000);
  expect(result.chunks.map((c) => c.chunk.id).sort()).toEqual(candidates.map((c) => c.chunk.id).sort());
  expect(result.skipped).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("a very large single chunk is included whole, never skipped or truncated", () => {
  const huge = item("huge", 0.9, Array.from({ length: 6000 }, (_unused, i) => `const v${i} = ${i};`).join("\n"));
  expect(huge.chunk.content.length).toBeGreaterThan(100_000);
  const result = selectByRelevance([huge, item("small", 0.8, body(40))], base);
  expect(result.chunks.map((c) => c.chunk.id).sort()).toEqual(["huge", "small"]);
  expect(result.chunks.find((c) => c.chunk.id === "huge")?.chunk.content).toBe(huge.chunk.content);
  expect(result.regions.find((r) => r.file === "huge.ts")?.content).toBe(huge.chunk.content);
  expect(result.skipped).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("breaks ties deterministically by path, range and ID regardless of input order", () => {
  const a = item("a", 0.8, body(40), "a.ts");
  const b = item("b", 0.8, body(40), "b.ts");
  const c = item("c", 0.8, body(40), "b.ts", 5);
  const first = selectByRelevance([a, b, c], base);
  const second = selectByRelevance([c, b, a], base);
  expect(first.chunks.map((x) => x.chunk.id)).toEqual(["a", "b", "c"]);
  expect(second).toEqual(first);
});

test("prints exact path:start-end locations followed by the source lines", () => {
  const code = "function f() {\n  return 1;\n}";
  const result = selectByRelevance([item("f", 0.9, code, "src/f.ts", 10)], base);
  const text = renderResult(result);
  expect(text).toContain("== src/f.ts:10-12 f (relevance 0.90) ==\nfunction f() {\n  return 1;\n}\n");
});

test("nothing relevant is an empty artifact that says so", () => {
  const empty = selectByRelevance([item("a", 0.2, body(10))], base);
  expect(empty.chunks).toEqual([]);
  expect(empty.skipped.map((skip) => skip.chunkId)).toEqual(["a"]);
  expect(empty.warnings).toEqual([
    expect.stringMatching(/^No relevant chunks found: no candidate scored at least 0.5/),
  ]);
  expect(selectByRelevance([], base).warnings).toEqual(["No relevant chunks found; the result is empty."]);
});

test("candidates below the minimum are recorded as skipped without a warning", () => {
  const good = item("good", 0.9, body(40));
  const weak = item("weak", 0.3, body(40));
  const result = selectByRelevance([good, weak], base);
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["good"]);
  expect(result.skipped).toEqual([
    {
      chunkId: "weak",
      file: "weak.ts",
      startLine: 1,
      endLine: 1,
      name: "weak",
      relevance: 0.3,
      score: 0.3,
    },
  ]);
  expect(result.warnings).toEqual([]);
});

test("skipped chunks are sorted by file, start line, then id regardless of input order", () => {
  const mk = (id: string, file: string, line: number) => item(id, 0.1, body(40), file, line);
  const entries = [
    mk("z", "b.ts", 1),
    mk("y", "a.ts", 20),
    mk("x", "a.ts", 3),
    mk("w", "a.ts", 3),
    mk("v", "a.ts", 100),
  ];
  const keep = item("keep", 0.9, body(40), "c.ts");
  const forward = selectByRelevance([keep, ...entries], base).skipped;
  expect(forward.map((s) => s.chunkId)).toEqual(["w", "x", "y", "v", "z"]);
  expect(selectByRelevance([...entries].reverse().concat(keep), base).skipped).toEqual(forward);
});

// Coherence: supporting declarations pulled in next to a selected chunk.

const asChunk = (entry: SelectedChunk): CodeChunk => entry.chunk;
const lookupOf = (...chunks: CodeChunk[]) => new Map(chunks.map((c) => [c.id, c]));

/** A class header chunk and one method of it; the method is the candidate, the header is not. */
function classWithMethod(headerBody: number, score = 0.9, methodBody = 60) {
  const header = item("Cls", 1, body(headerBody), "cls.ts", 1).chunk;
  header.kind = "class";
  const method = item("Cls.run", score, body(methodBody), "cls.ts", 10);
  method.chunk.kind = "method";
  method.chunk.parentId = "Cls";
  return { header, method };
}

test("a selected method pulls in its class header", () => {
  const { header, method } = classWithMethod(80);
  const result = selectByRelevance([method], { ...base, chunks: lookupOf(header, asChunk(method)) });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
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

test("a shared header is included once and lists every chunk that needs it", () => {
  const { header, method } = classWithMethod(60);
  const other = item("Cls.other", 0.8, body(60), "cls.ts", 20);
  other.chunk.kind = "method";
  other.chunk.parentId = "Cls";
  const chunks = lookupOf(header, asChunk(method), asChunk(other));
  const result = selectByRelevance([method, other], { ...base, chunks });
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
    const result = selectByRelevance(order, { ...base, chunks: lookupOf(header, asChunk(method)) });
    expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
    expect(result.chunks[0]?.relevance).toBe(0.95);
    expect(result.chunks[0]?.supportFor).toBeUndefined();
  }
});

test("a support that is also a relevant candidate keeps its own relevance whatever the order", () => {
  const { header, method } = classWithMethod(300, 0.9, 20);
  const candidate = { ...item("Cls", 0.55, header.content, "cls.ts", 1), chunk: header };
  const result = selectByRelevance([candidate, method], {
    ...base,
    chunks: lookupOf(header, asChunk(method)),
  });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Cls", "Cls.run"]);
  expect(result.chunks[0]?.relevance).toBe(0.55);
  expect(result.chunks[0]?.supportFor).toBeUndefined();
  expect(renderResult(result)).toContain("(relevance 0.55)");
});

test("a relevant header still pulls in the supports it needs itself", () => {
  // The method needs its header, and the header needs the class it extends.
  const { header, method } = classWithMethod(60, 0.9, 20);
  const base2 = item("Base", 1, body(40), "base.ts", 1).chunk;
  base2.kind = "class";
  header.references = [
    { kind: "extends", from: { file: "cls.ts", line: 1 }, name: "Base", targetChunkId: "Base", evidence: "exact" },
  ];
  const candidate = { ...item("Cls", 0.55, header.content, "cls.ts", 1), chunk: header };
  const result = selectByRelevance([candidate, method], {
    ...base,
    chunks: lookupOf(header, base2, asChunk(method)),
  });
  expect(result.chunks.map((c) => c.chunk.id)).toEqual(["Base", "Cls", "Cls.run"]);
  expect(result.chunks.find((c) => c.chunk.id === "Cls")?.relevance).toBe(0.55);
});

test("a support below the minimum score is still pulled in as context", () => {
  const { header, method } = classWithMethod(60);
  const weak = { ...item("Cls", 0.1, header.content, "cls.ts", 1), chunk: header };
  const chunks = lookupOf(header, asChunk(method));
  const result = selectByRelevance([method, weak], { ...base, chunks });
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
  const ids = () => selectByRelevance([user], { ...base, chunks }).chunks.map((c) => c.chunk.id);
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
  const run = (input: SelectedChunk[]) => selectByRelevance(input, { ...base, chunks });
  const forward = run([method, other, lone]);
  expect(run([lone, other, method])).toEqual(forward);
  expect(run([other, lone, method])).toEqual(forward);
});

test("a real method pulls in its class header from the mixed-app fixture", async () => {
  const { chunks } = await loadChunks(join(import.meta.dir, "../fixtures/mixed-app"));
  const file = "api/src/services/invoiceService.ts";
  const method = chunks.find((c) => c.file === file && c.name === "InvoiceService.markPaid")!;
  const header = chunks.find((c) => c.file === file && c.name === "InvoiceService")!;
  expect(method.parentId).toBe(header.id);
  const entry: SelectedChunk = { chunk: method, signals: {}, relevance: 0.9, score: 0.9, reason: "test" };
  const result = selectByRelevance([entry], { ...base, chunks: lookupOf(...chunks) });
  expect(result.chunks.map((c) => c.chunk.name)).toEqual(["InvoiceService", "InvoiceService.markPaid"]);
  expect(result.chunks[0]?.supportFor).toEqual([method.id]);
});
