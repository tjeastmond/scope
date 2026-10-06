import { expect, test } from "bun:test";
import { assembleChunks, type RawReference, type Region } from "../src/analyzers/assemble.ts";
import { extractPythonChunks } from "../src/analyzers/python.ts";

test("Python dynamic imports take the name= keyword; a positional argument wins", async () => {
  const source = [
    "import importlib",
    "def f(module_name):",
    '    a = importlib.import_module(name="pkg.fixed")',
    "    b = __import__(name=module_name)",
    '    c = __import__(globals=g, name="later")',
    '    d = importlib.import_module("pos", package="p")',
    '    e = __import__("first", name=other)',
    "    g = __import__(globals=g)",
  ].join("\n");
  const { chunks } = await extractPythonChunks("a.py", source);
  const refs = chunks.find((c) => c.name === "f")?.references.filter((r) => r.from.line > 1);
  expect(refs?.map((r) => [r.from.line, r.name, r.specifier, r.evidence])).toEqual([
    [3, "pkg.fixed", "pkg.fixed", undefined],
    [4, "module_name", undefined, "unresolved"],
    [5, "later", "later", undefined],
    [6, "pos", "pos", undefined],
    [7, "first", "first", undefined],
  ]);
});

test("attachment: 2,000 chunks and 2,000 references are fast and match the per-chunk definition", () => {
  // Chunk i spans line 2i+1; reference i sits on line 2i+1 (inside chunk i) when i is even, else on a gap line.
  const count = 2000;
  const source = Array.from({ length: count * 2 }, (_, i) => `line ${i}`).join("\n");
  const regions: Region[] = Array.from({ length: count }, (_, i) => ({
    startLine: 2 * i + 1,
    endLine: 2 * i + 1,
    kind: "function",
    name: `f${i}`,
  }));
  const references: RawReference[] = Array.from({ length: count }, (_, i) => ({
    kind: "import",
    line: i % 2 === 0 ? 2 * i + 1 : 2 * i + 2,
    name: `r${i}`,
  }));
  const started = performance.now();
  const { chunks } = assembleChunks("x.ts", source, "typescript", regions, false, "chunks", references);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(chunks).toHaveLength(count);
  const inRange = (r: RawReference, start: number, end: number) => r.line >= start && r.line <= end;
  const covered = (r: RawReference) => regions.some((g) => inRange(r, g.startLine, g.endLine));
  for (const index of [0, 1, 2, 999, 1000, 1999]) {
    const chunk = chunks[index]!;
    const expected = references
      .filter((r) => inRange(r, chunk.startLine, chunk.endLine) || !covered(r))
      .map((r) => `${r.line} ${r.name}`);
    expect(chunk.references.map((r) => `${r.from.line} ${r.name}`)).toEqual(expected);
  }
  expect(chunks[1]?.references).toHaveLength(count / 2);
});

test("attachment: many references on one line stay linear", () => {
  const count = 60_000;
  const references: RawReference[] = Array.from({ length: count }, (_, i) => ({
    kind: "import",
    line: 1,
    name: `m${i}`,
  }));
  const regions: Region[] = [{ startLine: 1, endLine: 1, kind: "function", name: "f" }];
  const started = performance.now();
  const { chunks } = assembleChunks("a.ts", "x", "typescript", regions, false, "line", references);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(chunks[0]?.references).toHaveLength(count);
});
