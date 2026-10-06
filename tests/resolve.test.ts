import { describe, expect, test } from "bun:test";
import { createImportResolver } from "../src/graph/resolve.ts";

const FILES = [
  "web/src/App.tsx",
  "web/src/lib/format.ts",
  "web/src/lib/util.js",
  "web/src/lib/legacy.cjs",
  "web/src/components/Card.tsx",
  "web/src/components/Esm.mts",
  "web/src/hooks/index.ts",
  "web/src/styles/invoice.module.css",
  "web/src/data.json",
  "top.ts",
  "index.ts",
  "sub/main.ts",
  "__init__.py",
  "root.py",
  "worker/__init__.py",
  "worker/main.py",
  "worker/tasks.py",
  "worker/pkg/__init__.py",
  "worker/pkg/inner.py",
  "worker/pkg/deep/leaf.py",
  "shared/common.py",
];
const resolve = createImportResolver(FILES);
const ts = (file: string, specifier: string) => resolve({ file, language: "typescript" }, specifier);
const py = (file: string, specifier: string) => resolve({ file, language: "python" }, specifier);

describe("TypeScript and JavaScript", () => {
  test.each([
    ["./lib/format", "web/src/lib/format.ts", "extension .ts appended"],
    ["./components/Card", "web/src/components/Card.tsx", "extension .tsx appended"],
    ["./lib/util", "web/src/lib/util.js", "extension .js appended"],
    ["./lib/legacy", "web/src/lib/legacy.cjs", "extension .cjs appended"],
    ["./components/Esm", "web/src/components/Esm.mts", "extension .mts appended"],
    ["./data", "web/src/data.json", "extension .json appended"],
    ["./lib/format.ts", "web/src/lib/format.ts", "exact path"],
    ["./styles/invoice.module.css", "web/src/styles/invoice.module.css", "exact path"],
    ["./hooks", "web/src/hooks/index.ts", "index file"],
    ["./hooks/", "web/src/hooks/index.ts", "index file"],
    ["./lib/format.js", "web/src/lib/format.ts", ".js specifier mapped to .ts source"],
    ["./components/Card.jsx", "web/src/components/Card.tsx", ".jsx specifier mapped to .tsx source"],
    ["./components/Esm.mjs", "web/src/components/Esm.mts", ".mjs specifier mapped to .mts source"],
    ["../App", "web/src/App.tsx", "extension .tsx appended"],
  ])("%s resolves to %s", (specifier, file, via) => {
    const importer = specifier.startsWith("../") ? "web/src/components/Card.tsx" : "web/src/App.tsx";
    expect(ts(importer, specifier)).toEqual({ file, via });
  });

  test("an existing .js file wins over the .ts mapping", () => {
    expect(ts("web/src/App.tsx", "./lib/util.js")).toEqual({ file: "web/src/lib/util.js", via: "exact path" });
  });

  test("a specifier of '.' or '..' resolves to the directory index", () => {
    expect(ts("web/src/hooks/useThing.ts", ".")).toEqual({ file: "web/src/hooks/index.ts", via: "index file" });
    expect(ts("web/src/hooks/inner/x.ts", "..")).toEqual({ file: "web/src/hooks/index.ts", via: "index file" });
  });

  test("a missing target is unresolved and names the path", () => {
    expect(ts("web/src/App.tsx", "./nope")).toEqual({
      unresolved: "no such file in the scanned repository: web/src/nope",
    });
  });

  test("a path that escapes the repository root is unresolved", () => {
    expect(ts("web/src/App.tsx", "../../../etc/x")).toEqual({ unresolved: "escapes the repository root" });
    expect(ts("top.ts", "../x")).toEqual({ unresolved: "escapes the repository root" });
    expect(ts("top.ts", "./web/src/App")).toMatchObject({ file: "web/src/App.tsx" });
  });

  test("bare packages and aliases are unresolved with distinct reasons", () => {
    expect(ts("web/src/App.tsx", "react")).toEqual({ unresolved: "bare package specifier" });
    expect(ts("web/src/App.tsx", "node:http")).toEqual({ unresolved: "bare package specifier" });
    for (const alias of ["@/lib/format", "~/lib/format", "#internal"]) {
      expect(ts("web/src/App.tsx", alias)).toEqual({ unresolved: "path alias or bare specifier not resolved in V1" });
    }
  });

  test("other languages are not resolved", () => {
    expect(resolve({ file: "a.css", language: "css" }, "./x")).toEqual({
      unresolved: "import resolution is not supported for css",
    });
  });
});

describe("Python", () => {
  test("a relative module is a sibling file or a package", () => {
    expect(py("worker/main.py", ".tasks")).toEqual({ file: "worker/tasks.py", via: "module file" });
    expect(py("worker/main.py", ".pkg")).toEqual({ file: "worker/pkg/__init__.py", via: "package __init__" });
    expect(py("worker/main.py", ".pkg.inner")).toEqual({ file: "worker/pkg/inner.py", via: "module file" });
  });

  test("'.' is the importer's package __init__", () => {
    expect(py("worker/main.py", ".")).toEqual({ file: "worker/__init__.py", via: "package __init__" });
    expect(py("shared/common.py", ".")).toEqual({
      unresolved: "no such file in the scanned repository: shared/__init__.py",
    });
  });

  test("extra dots go up one package each", () => {
    expect(py("worker/pkg/deep/leaf.py", "..inner")).toEqual({ file: "worker/pkg/inner.py", via: "module file" });
    expect(py("worker/pkg/deep/leaf.py", "...tasks")).toEqual({ file: "worker/tasks.py", via: "module file" });
    expect(py("worker/pkg/inner.py", "..")).toEqual({ file: "worker/__init__.py", via: "package __init__" });
  });

  test("a missing relative module is unresolved", () => {
    expect(py("worker/main.py", ".nope")).toEqual({
      unresolved: "no such file in the scanned repository: worker/nope.py",
    });
  });

  test("dots above the repository root escape it", () => {
    expect(py("worker/main.py", "...x")).toEqual({ unresolved: "escapes the repository root" });
  });

  test("absolute modules resolve from the repository root or the importer's top-level directory", () => {
    expect(py("worker/main.py", "tasks")).toEqual({ file: "worker/tasks.py", via: "module file" });
    expect(py("worker/main.py", "pkg.inner")).toEqual({ file: "worker/pkg/inner.py", via: "module file" });
    expect(py("web/x.py", "worker.pkg")).toEqual({ file: "worker/pkg/__init__.py", via: "package __init__" });
    expect(py("other/x.py", "shared.common")).toEqual({ file: "shared/common.py", via: "module file" });
  });

  test("standard library and third-party modules are unresolved", () => {
    expect(py("worker/main.py", "logging")).toEqual({
      unresolved: 'no local module for "logging" (external packages are not resolved)',
    });
  });
});

describe("files at the repository root", () => {
  test("a root index file and a root package __init__ resolve without a './' prefix", () => {
    expect(ts("top.ts", ".")).toEqual({ file: "index.ts", via: "index file" });
    expect(ts("sub/main.ts", "..")).toEqual({ file: "index.ts", via: "index file" });
    expect(py("root.py", ".")).toEqual({ file: "__init__.py", via: "package __init__" });
  });
});
