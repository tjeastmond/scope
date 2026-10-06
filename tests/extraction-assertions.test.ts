import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeFile } from "../src/analyzers/index.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { loadChunks } from "../src/scope.ts";
import type { AnalysisResult, CodeChunk, Language } from "../src/types.ts";
import { expectContainerInvariants } from "./helpers/chunk-invariants.ts";

/**
 * Cross-analyzer extraction assertions over real parsers. Each case is one sample per analyzer (Unicode, nesting where
 * the language has it, duplicate names) plus a malformed input. Every case is run through the line-ending, trailing
 * newline and empty-file variants below, so the invariants hold for all analyzers alike. The per-analyzer tests own the
 * exact inventories; this file owns what must hold everywhere.
 */
interface Case {
  analyzer: string;
  path: string;
  language: Language;
  sample: string;
  /** Names that must be extracted from `sample` (a subset, so unrelated chunks do not break the case). */
  names: string[];
  malformed: string;
}

const CASES: Case[] = [
  {
    analyzer: "ecmascript",
    path: "src/größe.ts",
    language: "typescript",
    sample: [
      "export namespace Größe {",
      "  export class 合計 {",
      "    total = 0;",
      "",
      '    add(): string { return "日本語"; }',
      "    reset(): void { this.total = 0; }",
      "  }",
      "}",
      "export function dup() { return 1; }",
      "export function dup(x: number) { return x; }",
      "",
    ].join("\n"),
    names: ["Größe", "Größe.合計", "Größe.合計.add", "Größe.合計.reset", "dup"],
    malformed: "export function ok() { return 1; }\nexport function broken( {\n  const x = ;\n",
  },
  {
    analyzer: "python",
    path: "worker/kundin.py",
    language: "python",
    sample: [
      "class Kundin:",
      '    """Kundin 日本."""',
      "",
      "    class Stats:",
      '        """Stats."""',
      "",
      "        def record(self):",
      '            return "grüßen 日本"',
      "",
      "        def reset(self):",
      "            return 0",
      "",
      "    def fällig(self):",
      "        return 1",
      "",
      "def dup():",
      "    return 1",
      "",
      "def dup():",
      "    return 2",
      "",
    ].join("\n"),
    names: ["Kundin", "Kundin.Stats", "Kundin.Stats.record", "Kundin.fällig", "dup"],
    malformed: "def ok():\n    return 1\n\ndef broken(:\n    pass\n  x = (\n",
  },
  {
    analyzer: "markdown",
    path: "docs/über.md",
    language: "markdown",
    sample: "# Über\n\nText 日本\n\n## Sub\n\ntext\n\n## Sub\n\nagain\n",
    names: ["Über", "Über > Sub"],
    malformed: "# Head\n\n```sh\nunclosed fence\n## still code\n<!-- unterminated\n",
  },
  {
    analyzer: "config (json)",
    path: "config/settings.json",
    language: "json",
    sample: '{\n  "ключ": "値",\n  "nested": { "a": 1 },\n  "dup": 1,\n  "dup": 2\n}\n',
    names: ["ключ", "nested", "dup"],
    malformed: '{\n  "a": 1,\n  "b": [1, 2,\n',
  },
  {
    analyzer: "config (yaml)",
    path: "config/app.yaml",
    language: "yaml",
    sample: "ключ: 値\nnested:\n  a: 1\ndup: 1\ndup: 2\n",
    names: ["ключ", "nested"],
    malformed: "a: 1\nb: [1, 2\nc: : :\n",
  },
  {
    analyzer: "config (toml)",
    path: "config/app.toml",
    language: "toml",
    sample: 'title = "日本"\n[server]\nport = 1\n[[dup]]\nx = 1\n[[dup]]\nx = 2\n',
    names: ["title", "server"],
    malformed: "a = 1\nb = \n[unclosed\n",
  },
  {
    analyzer: "sql",
    path: "db/café.sql",
    language: "sql",
    sample: "CREATE TABLE café (id int, note text DEFAULT '日本;語');\n\nSELECT * FROM café;\n\nSELECT * FROM café;\n",
    names: [],
    malformed: "CREATE TABLE ok (id int);\nSELECT 'unterminated string;\nFROM x\n",
  },
  {
    analyzer: "markup",
    path: "web/index.html",
    language: "html",
    sample: "<!doctype html>\n<html><body>\n<main>\n<h1>Größe 日本</h1>\n</main>\n<footer>x</footer>\n</body></html>\n",
    names: [],
    malformed: "<main>\n<div><p>oops\n</main>\n<section>\n",
  },
  {
    analyzer: "style (css)",
    path: "web/site.css",
    language: "css",
    sample: ".größe { color: red; }\n.dup { a: b; }\n.dup { a: c; }\n@media (min-width: 1px) {\n  .x { y: z; }\n}\n",
    names: [],
    malformed: ".ok { a: b; }\n.bad { a: \n.next { c: d; }\n}}\n",
  },
  {
    analyzer: "style (scss)",
    path: "web/site.scss",
    language: "scss",
    sample: ".größe { .b { c: d; } }\n.dup { a: b; }\n.dup { a: c; }\n",
    names: [],
    malformed: ".ok { a: b; }\n.bad { .b { c: \n$x: ;\n",
  },
  {
    analyzer: "text fallback",
    path: "cmd/main.go",
    language: "go",
    sample: "package main\n\n// größe 日本\nfunc main() {}\nfunc main() {}\n",
    names: [],
    malformed: "}{ ((( \u0001   unbalanced\nfunc (",
  },
];

const analyze = (c: Case, source: string): Promise<AnalysisResult> =>
  analyzeFile({ path: c.path, source }, c.language, heuristicEstimator);

const identity = (s: string) => s;
const toCrlf = (s: string) => s.replace(/\n/g, "\r\n");
/** Alternates CRLF and LF so one file mixes both line endings. */
const toMixed = (s: string) => {
  let n = 0;
  return s.replace(/\n/g, () => (n++ % 2 ? "\n" : "\r\n"));
};
const withoutTrailingNewline = (s: string) => s.replace(/\r?\n$/, "");

/**
 * The container policy for chunks that nest through `parentId`. Markdown sections nest by range alone (a parent's
 * range covers its children, docs/chunk-model.md), so for them only id uniqueness applies.
 */
function expectStructure(chunks: readonly CodeChunk[]): void {
  if (chunks.some((chunk) => chunk.language === "markdown")) {
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  } else expectContainerInvariants(chunks);
}

/** What must hold for any chunk list over `source`: sane ranges, byte-exact content, container policy. */
function expectInvariants(chunks: readonly CodeChunk[], source: string): void {
  const lines = source.split("\n");
  for (const chunk of chunks) {
    expect(chunk.startLine).toBeGreaterThanOrEqual(1);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    expect(chunk.endLine).toBeLessThanOrEqual(lines.length);
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunk.estimatedTokens).toBeGreaterThan(0);
  }
  expectStructure(chunks);
}

/** The position-based identity of an inventory, comparable across line-ending variants. */
const shape = (chunks: readonly CodeChunk[]) =>
  chunks.map((c) => [c.id, c.kind, c.name, c.startLine, c.endLine, c.parentId, c.containerName]);

describe.each(CASES)("extraction: $analyzer", (c) => {
  test("the sample yields its expected symbols, with exact lines through multi-byte text", async () => {
    const { chunks } = await analyze(c, c.sample);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.name)).toEqual(expect.arrayContaining(c.names));
    expectInvariants(chunks, c.sample);
  });

  test("same input gives identical chunks and warnings, and duplicate names get distinct ids", async () => {
    const [a, b] = [await analyze(c, c.sample), await analyze(c, c.sample)];
    expect(b).toEqual(a);
    expect(new Set(a.chunks.map((chunk) => chunk.id)).size).toBe(a.chunks.length);
  });

  test.each([
    ["CRLF", toCrlf],
    ["mixed line endings", toMixed],
  ])("%s: invariants hold and ranges, ids and names match the LF sample", async (_label, transform) => {
    const source = transform(c.sample);
    const { chunks } = await analyze(c, source);
    expectInvariants(chunks, source);
    expect(shape(chunks)).toEqual(shape((await analyze(c, c.sample)).chunks));
  });

  test("no trailing newline: invariants hold and the same symbols are found", async () => {
    const source = withoutTrailingNewline(c.sample);
    const { chunks } = await analyze(c, source);
    expectInvariants(chunks, source);
    expect(chunks.map((chunk) => chunk.name)).toEqual((await analyze(c, c.sample)).chunks.map((chunk) => chunk.name));
  });

  test.each([
    ["an empty file", ""],
    ["a blank file", "\n\n  \n"],
  ])("%s yields no chunks and does not throw", async (_label, source) => {
    expect((await analyze(c, source)).chunks).toEqual([]);
  });

  test.each([
    ["LF", identity],
    ["CRLF", toCrlf],
    ["no trailing newline", withoutTrailingNewline],
  ])("malformed input (%s) never throws, stays within the file and is deterministic", async (_label, transform) => {
    const source = transform(c.malformed);
    const first = await analyze(c, source);
    expect(first.chunks.length).toBeGreaterThan(0);
    expectInvariants(first.chunks, source);
    expect(await analyze(c, source)).toEqual(first);
  });
});

describe("mixed-app extraction", async () => {
  const root = join(import.meta.dir, "../fixtures/mixed-app");
  const { chunks } = await loadChunks(root);
  const files = [...new Set(chunks.map((chunk) => chunk.file))];

  test("every chunk has a sane range and the container policy holds file by file", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const inFile = chunks.filter((chunk) => chunk.file === file);
      expectStructure(inFile);
      for (const chunk of inFile) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.estimatedTokens).toBeGreaterThan(0);
      }
    }
  });

  test("ids are unique across the whole fixture, not only within a file", () => {
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  test("every analyzer produced chunks for the fixture", () => {
    const languages = new Set(chunks.map((chunk) => chunk.language));
    for (const language of ["typescript", "python", "markdown", "json", "toml", "sql", "html", "css", "scss"]) {
      expect(languages).toContain(language as Language);
    }
  });

  test("whole chunks, not just ids, come back identical on a second run", async () => {
    expect((await loadChunks(root)).chunks).toEqual(chunks);
  });
});
