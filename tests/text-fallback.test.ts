import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFile } from "../src/analyzers/index.ts";
import { TEXT_WINDOW_LINES, TEXT_WINDOW_MAX_LINES } from "../src/analyzers/text.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk, Language } from "../src/types.ts";

const analyze = (path: string, source: string, language: Language) =>
  analyzeFile({ path, source }, language, charsPerTokenEstimator);

const ranges = (chunks: CodeChunk[]) => chunks.map((c) => [c.startLine, c.endLine]);

/** No two chunks share a line. */
function expectNoOverlap(chunks: CodeChunk[]) {
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.startLine).toBeGreaterThan(sorted[i - 1]!.endLine);
}

/** Every chunk's content is exactly its source lines. */
function expectExactContent(source: string, chunks: CodeChunk[]) {
  const lines = source.split("\n");
  for (const c of chunks) expect(c.content).toBe(lines.slice(c.startLine - 1, c.endLine).join("\n"));
}

const repos: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});
async function makeRepo(files: Record<string, string | Buffer>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "scope-fallback-"));
  repos.push(repo);
  for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
  return repo;
}

test("an unknown extension becomes one file chunk and a warning naming file and reason, end to end", async () => {
  const repo = await makeRepo({ "notes.zzz": "first line\nsecond line\n" });
  const { result } = await runScope({ task: "anything", repo, noJev: true });
  expect(result.chunks.map((s) => [s.chunk.file, s.chunk.kind, s.chunk.startLine, s.chunk.endLine])).toEqual([
    ["notes.zzz", "file", 1, 2],
  ]);
  expect(result.chunks[0]!.chunk.content).toBe("first line\nsecond line");
  expect(result.warnings).toEqual([
    'notes.zzz: no analyzer for language "text"; text fallback produced 1 line window(s)',
  ]);
});

test("a known language with no analyzer is covered the same way", async () => {
  const result = await analyze("main.go", "package main\n\nfunc main() {}\n", "go");
  expect(result.chunks.map((c) => [c.kind, c.startLine, c.endLine, c.language])).toEqual([["file", 1, 3, "go"]]);
  expect(result.warnings).toEqual([expect.stringMatching(/^main\.go: no analyzer for language "go"; /)]);
});

const TRUNCATED = [
  'import { x } from "./x";', // 1: not a declaration, so a gap
  "", // 2
  "export function ok(a: number) {", // 3
  "  return a + 1;", // 4
  "}", // 5
  "", // 6
  "export function broken(a: number) {", // 7: never closed
  "  const y = [1, 2",
  "  return a * y.length;",
].join("\n");

test("a truncated TypeScript file keeps recovered chunks and fills only the gaps, with no overlap", async () => {
  const result = await analyze("src/t.ts", TRUNCATED, "typescript");
  const recovered = result.chunks.filter((c) => c.kind === "function");
  expect(recovered.map((c) => [c.name, c.startLine, c.endLine])).toEqual([["ok", 3, 5]]);
  const windows = result.chunks.filter((c) => c.kind === "section");
  expect(ranges(windows)).toEqual([
    [1, 1],
    [7, 9],
  ]);
  expect(windows.map((c) => c.language)).toEqual(["typescript", "typescript"]);
  expectNoOverlap(result.chunks);
  expectExactContent(TRUNCATED, result.chunks);
  expect(result.chunks.map((c) => c.startLine)).toEqual([1, 3, 7]);
  expect(result.warnings).toEqual([
    "src/t.ts: syntax errors; extracted 1 declarations from the parseable regions",
    "src/t.ts: syntax errors; text fallback produced 2 line window(s) over the lines the parser did not recover",
  ]);
});

test("a truncated file with nothing recoverable falls back to the whole file", async () => {
  const source = "function (a {\n  return\n";
  const result = await analyze("bad.ts", source, "typescript");
  expect(result.chunks.map((c) => [c.kind, c.startLine, c.endLine])).toEqual([["file", 1, 2]]);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.every((w) => w.startsWith("bad.ts: "))).toBe(true);
});

test("a recovered file that is merely quirky, not broken, gets no fallback", async () => {
  const source = 'import { x } from "./x";\n\nexport function ok() {\n  return x;\n}\n';
  const result = await analyze("ok.ts", source, "typescript");
  expect(result.chunks.map((c) => c.name)).toEqual(["ok"]);
  expect(result.warnings).toEqual([]);
});

test("a binary-looking tail past the scanner's sniff window is skipped with a warning and no chunks", async () => {
  const source = `${"export const a = 1;\n".repeat(600)}\0\0\0binary tail`;
  const result = await analyze("odd.ts", source, "typescript");
  expect(result.chunks).toEqual([]);
  expect(result.warnings).toEqual(["odd.ts: binary content (NUL byte); skipped"]);

  const repo = await makeRepo({
    "blob.zzz": Buffer.from(`${"plain text line\n".repeat(1000)}\0tail`),
    "ok.py": "def ok():\n    pass\n",
  });
  const run = await runScope({ task: "anything", repo, noJev: true });
  expect(run.result.chunks.map((s) => s.chunk.file)).toEqual(["ok.py"]);
  expect(run.result.warnings).toEqual(["blob.zzz: binary content (NUL byte); skipped"]);
});

test("long files without blank lines split at exactly the target size and cover every line", async () => {
  const total = TEXT_WINDOW_LINES * 3 + 7;
  const source = Array.from({ length: total }, (_, i) => `line ${i + 1}`).join("\n");
  const { chunks, warnings } = await analyze("big.zzz", source, "text");
  expect(ranges(chunks)).toEqual([
    [1, 80],
    [81, 160],
    [161, 240],
    [241, 247],
  ]);
  expect(chunks.every((c) => c.kind === "section")).toBe(true);
  expectNoOverlap(chunks);
  expectExactContent(source, chunks);
  expect(warnings).toEqual([expect.stringContaining("big.zzz: no analyzer")]);
});

test("windows end on a blank line near the target and never exceed the hard maximum", async () => {
  // Paragraphs of 30 lines separated by a blank line: the blank lines fall at 31, 62, 93, 124, ...
  const paragraph = (n: number) => Array.from({ length: 30 }, (_, i) => `p${n} l${i + 1}`).join("\n");
  const source = Array.from({ length: 8 }, (_, n) => paragraph(n)).join("\n\n");
  const { chunks } = await analyze("prose.zzz", source, "text");
  expect(ranges(chunks)).toEqual([
    [1, 92], // the blank at 93 is nearest the target (80) within reach
    [94, 185],
    [187, 247],
  ]);
  for (const c of chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(TEXT_WINDOW_MAX_LINES);
  expectNoOverlap(chunks);
  expectExactContent(source, chunks);

  // A blank line only beyond the hard maximum is not used.
  const far = `${Array.from({ length: 150 }, (_, i) => `x${i}`).join("\n")}\n\ntail`;
  const farChunks = (await analyze("far.zzz", far, "text")).chunks;
  expect(farChunks[0]!.endLine - farChunks[0]!.startLine + 1).toBe(TEXT_WINDOW_LINES);
  for (const c of farChunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(TEXT_WINDOW_MAX_LINES);
});

test("CRLF text keeps its original content and the same ranges", async () => {
  const { chunks } = await analyze("w.zzz", "a\r\nb\r\n\r\nc\r\n", "text");
  expect(chunks).toHaveLength(1);
  expect([chunks[0]!.startLine, chunks[0]!.endLine]).toEqual([1, 4]);
  expect(chunks[0]!.content).toBe("a\r\nb\r\n\r\nc\r");
});

test("empty and blank-only files produce no chunks and no warning", async () => {
  for (const source of ["", "\n", "  \n\t\n\n"]) {
    expect(await analyze("blank.zzz", source, "text")).toEqual({ chunks: [], warnings: [] });
  }
  const repo = await makeRepo({ "empty.zzz": "", "blank.zzz": "\n\n", "ok.py": "def ok():\n    pass\n" });
  const { result } = await runScope({ task: "anything", repo, noJev: true });
  expect(result.chunks.map((s) => s.chunk.file)).toEqual(["ok.py"]);
  expect(result.warnings).toEqual([]);
});

test("a structural analyzer that extracts nothing from a non-blank file falls back to text", async () => {
  const result = await analyze("page.html", "<div>just text, no landmarks</div>\n", "html");
  expect(result.chunks.map((c) => [c.kind, c.startLine, c.endLine])).toEqual([["file", 1, 1]]);
  expect(result.warnings).toEqual([expect.stringMatching(/^page\.html: analyzer extracted no chunks; /)]);
});
