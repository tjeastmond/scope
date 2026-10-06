import { expect, test } from "bun:test";
import { extractEcmascript } from "../src/analyzers/ecmascript.ts";
import { extractPythonChunks } from "../src/analyzers/python.ts";
import type { Reference } from "../src/types.ts";

/** Compact `line name <- specifier [evidence]` form of every distinct reference in a file's chunks. */
async function refsOf(
  language: "ts" | "py",
  source: string,
  path = language === "ts" ? "a.ts" : "a.py",
): Promise<string[]> {
  const result = language === "ts" ? await extractEcmascript(path, source) : await extractPythonChunks(path, source);
  const seen = new Map<string, Reference>();
  for (const chunk of result.chunks) {
    for (const ref of chunk.references) seen.set(JSON.stringify(ref), ref);
  }
  return [...seen.values()].map(
    (r) =>
      `${r.from.line} ${r.name}${r.specifier === undefined ? "" : ` <- ${r.specifier}`}${r.evidence ? ` [${r.evidence}]` : ""}`,
  );
}

test("TS/JS static import forms: one reference per binding", async () => {
  const refs = await refsOf(
    "ts",
    [
      'import def from "./a.ts";',
      'import { one, two as second } from "./b";',
      'import * as ns from "./c";',
      'import "./side-effect";',
      'import type { T } from "./types";',
      'import { type U, v } from "./mixed";',
      'import Def2, { named } from "pkg";',
      'import e = require("legacy");',
      "export const x = 1;",
    ].join("\n"),
  );
  expect(refs).toEqual([
    "1 default <- ./a.ts",
    "2 one <- ./b",
    "2 two <- ./b",
    "3 ns <- ./c",
    "4 ./side-effect <- ./side-effect",
    "5 T <- ./types",
    "6 U <- ./mixed",
    "6 v <- ./mixed",
    "7 default <- pkg",
    "7 named <- pkg",
    "8 e <- legacy",
  ]);
});

test("TS/JS export-from and re-exports", async () => {
  const refs = await refsOf(
    "ts",
    [
      'export * from "./all";',
      'export * as star from "./star";',
      'export { a, b as c } from "./some";',
      'export type { Shape } from "./shape";',
      "const local = 1;",
      "export { local };",
      "export default function main() {}",
    ].join("\n"),
  );
  expect(refs).toEqual(["1 * <- ./all", "2 star <- ./star", "3 a <- ./some", "3 b <- ./some", "4 Shape <- ./shape"]);
});

test("require and dynamic import: literals are plain, computed forms are unresolved with their source text", async () => {
  const source = [
    'const fs = require("node:fs");',
    'const lazy = () => import("./lazy.js");',
    "const a = require(name);",
    "const b = import(`./locale/${lang}.js`);",
    'const c = require("./dir/" + file);',
    "const d = require(`./static`);",
    "const e = require.resolve('x');",
    "const f = require();",
  ].join("\n");
  const refs = await refsOf("ts", source, "a.js");
  expect(refs).toEqual([
    "1 node:fs <- node:fs",
    "2 ./lazy.js <- ./lazy.js",
    "3 name [unresolved]",
    "4 `./locale/${lang}.js` [unresolved]",
    '5 "./dir/" + file [unresolved]',
    "6 ./static <- ./static",
  ]);
});

test("TS/JS references attach by line range, and top-level ones to every chunk of the file", async () => {
  const source = [
    'import { shared } from "./shared";', // 1: in no chunk
    "export function first() {", //            2
    '  const m = require("./inner");', //      3: only inside first
    "  return m;", //                          4
    "}", //                                    5
    "export function second() {", //           6
    "  return import(dynamicPath);", //        7: only inside second
    "}", //                                    8
  ].join("\n");
  const { chunks } = await extractEcmascript("a.ts", source);
  const names = (name: string) => chunks.find((c) => c.name === name)?.references.map((r) => r.name);
  expect(names("first")).toEqual(["shared", "./inner"]);
  expect(names("second")).toEqual(["shared", "dynamicPath"]);
  const second = chunks.find((c) => c.name === "second");
  expect(second?.references[0]).toEqual({
    kind: "import",
    from: { file: "a.ts", line: 1 },
    name: "shared",
    specifier: "./shared",
  });
  expect(second?.references[1]).toMatchObject({ from: { file: "a.ts", line: 7 }, evidence: "unresolved" });
  for (const ref of chunks.flatMap((c) => c.references)) expect(ref.targetChunkId).toBeUndefined();
});

test("TS/JS: files without imports and statement-only files have no references", async () => {
  const none = await extractEcmascript("a.ts", "export function f() { return 1; }\n");
  expect(none.chunks[0]?.references).toEqual([]);
  const importsOnly = await extractEcmascript("a.ts", 'import "x";\n');
  expect(importsOnly.chunks).toEqual([]);
});

test("Python import forms", async () => {
  const refs = await refsOf(
    "py",
    [
      "import os",
      "import a.b",
      "import a.b as ab, json",
      "from x import y",
      "from x import (a, b as c)",
      "from . import sibling",
      "from ..pkg import z",
      "from .mod import q",
      "from x import *",
      "from __future__ import annotations",
      "",
      "def f():",
      "    pass",
    ].join("\n"),
  );
  expect(refs).toEqual([
    "1 os <- os",
    "2 a.b <- a.b",
    "3 ab <- a.b",
    "3 json <- json",
    "4 y <- x",
    "5 a <- x",
    "5 b <- x",
    "6 sibling <- .",
    "7 z <- ..pkg",
    "8 q <- .mod",
    "9 * <- x",
    "10 annotations <- __future__",
  ]);
});

test("Python dynamic imports: literals plain, non-literals unresolved, nested imports attach to their function", async () => {
  const source = [
    "import importlib",
    "",
    "def load(name):",
    "    try:",
    "        import yaml",
    "    except ImportError:",
    "        yaml = None",
    "    mod = importlib.import_module(name)",
    '    other = importlib.import_module("pkg.fixed")',
    '    return __import__(f"plugins.{name}"), __import__("fixed")',
    "",
    "def plain():",
    "    return 1",
  ].join("\n");
  const { chunks } = await extractPythonChunks("a.py", source);
  const load = chunks.find((c) => c.name === "load");
  const plain = chunks.find((c) => c.name === "plain");
  expect(load?.references.map((r) => [r.from.line, r.name, r.specifier, r.evidence])).toEqual([
    [1, "importlib", "importlib", undefined],
    [5, "yaml", "yaml", undefined],
    [8, "name", undefined, "unresolved"],
    [9, "pkg.fixed", "pkg.fixed", undefined],
    [10, 'f"plugins.{name}"', undefined, "unresolved"],
    [10, "fixed", "fixed", undefined],
  ]);
  // Only the top-level import is file-level; the ones inside `load` are not attached to `plain`.
  expect(plain?.references.map((r) => r.name)).toEqual(["importlib"]);
});

test("Python: no imports, no references", async () => {
  const { chunks } = await extractPythonChunks("a.py", "def f():\n    return 1\n");
  expect(chunks[0]?.references).toEqual([]);
});

test("a container header and its members each get file-level references once", async () => {
  const source = [
    "import os",
    "class Big:",
    '    """Doc."""',
    "    x = 1",
    "",
    "    def a(self):",
    "        return 1",
    "",
    "    def b(self):",
    "        return 2",
    "",
    "    def c(self):",
    "        return 3",
  ].join("\n");
  const { chunks } = await extractPythonChunks("a.py", source);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) expect(chunk.references.map((r) => r.name)).toEqual(["os"]);
});

test("Python dynamic imports: **kwargs does not override an explicit name= keyword", async () => {
  const source = [
    "import importlib",
    "def f(options):",
    '    a = __import__(name="pkg", **options)',
    '    b = importlib.import_module(**options, name="other")',
  ].join("\n");
  const { chunks } = await extractPythonChunks("a.py", source);
  const refs = chunks.find((c) => c.name === "f")?.references.filter((r) => r.from.line > 1);
  expect(refs?.map((r) => [r.from.line, r.name, r.evidence])).toEqual([
    [3, "pkg", undefined],
    [4, "other", undefined],
  ]);
});

test("local bindings and namespace imports are recorded", async () => {
  const ts = await extractEcmascript(
    "a.ts",
    [
      'import def from "./a";',
      'import { one, two as second } from "./b";',
      'import * as ns from "./c";',
      "export const x = 1;",
    ].join("\n"),
  );
  const byName = new Map(ts.chunks.flatMap((c) => c.references).map((r) => [r.name, r]));
  expect(byName.get("default")?.local).toBe("def");
  expect(byName.get("one")?.local).toBeUndefined();
  expect(byName.get("two")?.local).toBe("second");
  expect(byName.get("ns")).toMatchObject({ namespace: true });
  expect(byName.get("ns")?.local).toBeUndefined();

  const py = await extractPythonChunks(
    "a.py",
    ["import a.b as ab", "from x import y as z, w", "", "def f():", "    pass"].join("\n"),
  );
  const pyRefs = new Map(py.chunks.flatMap((c) => c.references).map((r) => [r.name, r]));
  expect(pyRefs.get("ab")).toMatchObject({ namespace: true, specifier: "a.b" });
  expect(pyRefs.get("y")?.local).toBe("z");
  expect(pyRefs.get("w")?.local).toBeUndefined();
  expect(pyRefs.get("w")?.namespace).toBeUndefined();
});
