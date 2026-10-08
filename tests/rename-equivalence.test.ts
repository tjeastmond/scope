import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { analyzeFile } from "../src/analyzers/index.ts";
import { canReuseOnRename, retargetAnalysis } from "../src/cache/rename.ts";
import { classifyFile } from "../src/repository/language.ts";
import { redactSecrets } from "../src/repository/redact.ts";
import type { CachedAnalysis } from "../src/cache/analysis.ts";

const ROOT = join(import.meta.dir, "..");
const HEAD_CHARS = 1024;

async function analyze(path: string, text: string): Promise<CachedAnalysis | undefined> {
  const { language } = classifyFile(path, text.slice(0, HEAD_CHARS));
  if (!language || text.includes("\0")) return undefined;
  const result = await analyzeFile({ path, source: redactSecrets(text) }, language);
  return { chunks: result.chunks, warnings: result.warnings, textOnly: result.textOnly === true };
}

async function filesUnder(directory: string, prefix: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];
  for (const entry of await readdir(join(ROOT, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = posix.join(prefix, absolute.slice(join(ROOT, directory).length + 1));
    found.push({ path, text: await readFile(absolute, "utf8") });
  }
  return found;
}

// Sources that exercise what the real files may not: containers (parentId), partial parses and analyzer warnings.
const SYNTHETIC: Record<string, string> = {
  "synthetic/shapes.ts":
    "export class Shape {\n  area() { return 1; }\n  name = 'shape';\n}\nexport namespace N { export const x = 1; }\n",
  "synthetic/broken.ts": "export function ok() { return 1; }\nexport function (((\n",
  "synthetic/Widget.tsx": "export function Widget() { return <div className='a'>hi</div>; }\n",
  "synthetic/legacy.js": "class A { m() { return require('./b'); } }\nmodule.exports = A;\n",
  "synthetic/models.py": "class A:\n    def m(self):\n        return 1\n\ndef broken(:\n",
  "synthetic/config.jsonc": '{\n  // note\n  "a": 1\n}\n',
  "synthetic/schema.sql": "CREATE TABLE t (id int);\nSELECT * FROM t;\nthis is not sql (((\n",
  "synthetic/page.html": "<html><body><div id='a'>x</div></body></html>\n",
  "synthetic/site.scss": ".a { .b { color: red; } }\n",
  "synthetic/notes.md": "# Title\n\ntext\n\n## Sub\n\nmore\n",
  "synthetic/main.go": "package main\n\nfunc main() {}\n",
  "synthetic/readme.txt": "just words\n".repeat(200),
  "synthetic/values.toml": 'a = 1\n[b]\nc = "x"\n',
  "synthetic/values.yaml": "a: 1\nb:\n  - c\n",
};

describe("retargeting an analysis equals analyzing at the new path", () => {
  test("over every analyzable file in the fixtures, this repository's sources and synthetic sources", async () => {
    const sources = [
      ...(await filesUnder("fixtures", "fixtures")),
      ...(await filesUnder("src", "src")),
      ...Object.entries(SYNTHETIC).map(([path, text]) => ({ path, text })),
    ];
    let checked = 0;
    let withParent = 0;
    let withWarnings = 0;
    let withTextOnly = 0;
    const extensions = new Set<string>();
    for (const [index, { path, text }] of sources.entries()) {
      const extension = posix.extname(path);
      const moved = `other/dir${index % 3}/renamed-${index}${extension}`;
      const before = await analyze(path, text);
      if (!before) continue;
      expect(canReuseOnRename(path, moved, text.slice(0, HEAD_CHARS))).toBe(extension.length > 1);
      if (extension.length <= 1) continue;
      const after = await analyze(moved, text);
      expect(retargetAnalysis(before, path, moved), path).toEqual(after!);
      checked++;
      extensions.add(extension.toLowerCase());
      if (before.chunks.some((chunk) => chunk.parentId !== undefined)) withParent++;
      if (before.warnings.length > 0) withWarnings++;
      if (before.textOnly) withTextOnly++;
    }
    expect(checked).toBeGreaterThan(80);
    // The sample covers what the rewrite must handle, so a missing remap cannot go unnoticed.
    expect(withParent).toBeGreaterThan(0);
    expect(withWarnings).toBeGreaterThan(0);
    expect(withTextOnly).toBeGreaterThan(0);
    for (const extension of [".ts", ".tsx", ".js", ".py", ".sql", ".html", ".scss", ".md", ".json", ".yaml", ".toml"]) {
      expect(extensions.has(extension), extension).toBe(true);
    }
  });
});

describe("canReuseOnRename", () => {
  test("needs the same non-empty extension", () => {
    expect(canReuseOnRename("a/b.ts", "c/d.ts", "x")).toBe(true);
    expect(canReuseOnRename("a/b.TS", "c/d.ts", "x")).toBe(true);
    expect(canReuseOnRename("a/b.ts", "a/b.tsx", "x")).toBe(false);
    expect(canReuseOnRename("a/b.ts", "a/b.js", "x")).toBe(false);
    expect(canReuseOnRename("Makefile", "build/Makefile", "x")).toBe(false);
    expect(canReuseOnRename("run", "bin/run", "#!/usr/bin/env python3\n")).toBe(false);
    expect(canReuseOnRename("a/.gitignore", "b/.gitignore", "x")).toBe(false);
  });
});
