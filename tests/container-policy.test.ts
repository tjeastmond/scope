import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFile } from "../src/analyzers/index.ts";
import { scanRepository } from "../src/repository/files.ts";
import { classifyFile } from "../src/repository/language.ts";
import type { CodeChunk, Language } from "../src/types.ts";
import { expectContainerInvariants } from "./helpers/chunk-invariants.ts";

async function chunksOf(path: string, language: Language, ...sourceLines: string[]): Promise<CodeChunk[]> {
  const source = sourceLines.join("\n") + "\n";
  const { chunks } = await analyzeFile({ path, source }, language);
  expectContainerInvariants(chunks);
  return chunks;
}

const describeChunk = (c: CodeChunk) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`;
const byName = (chunks: CodeChunk[], name: string): CodeChunk => {
  const found = chunks.find((c) => c.name === name);
  if (!found) throw new Error(`no chunk named ${name}`);
  return found;
};

const TS_CLASS = [
  "export class Cart {", // 1
  "  private items: string[] = [];", // 2
  "  static readonly MAX = 10;", // 3
  "", // 4
  "  add(item: string): void {", // 5
  "    this.items.push(item);", // 6
  "  }", // 7
  "", // 8
  "  @Memo()", // 9
  "  get size(): number {", // 10
  "    return this.items.length;", // 11
  "  }", // 12
  "}", // 13
  "export const after = 1;", // 14
];

test("a TypeScript class is a header chunk plus one chunk per method, linked by parentId", async () => {
  const chunks = await chunksOf("cart.ts", "typescript", ...TS_CLASS);
  expect(chunks.map(describeChunk)).toEqual([
    "class:Cart@1-3",
    "method:Cart.add@5-7",
    "method:Cart.get size@9-12",
    "config:after@14-14",
  ]);
  const header = byName(chunks, "Cart");
  expect(header.content).toBe(TS_CLASS.slice(0, 3).join("\n"));
  expect(header.content).not.toContain("push");
  expect(header.parentId).toBeUndefined();
  for (const name of ["Cart.add", "Cart.get size"]) {
    expect(byName(chunks, name).parentId).toBe(header.id);
    expect(byName(chunks, name).containerName).toBe("Cart");
  }
  expect(byName(chunks, "after").parentId).toBeUndefined();
});

test("a JavaScript class splits the same way and keeps ids stable", async () => {
  const source = [
    "class Store {", // 1
    "  #items = [];", // 2
    "  constructor() {", // 3
    "    this.ready = true;", // 4
    "  }", // 5
    "  put(x) {", // 6
    "    this.#items.push(x);", // 7
    "  }", // 8
    "  static of() {", // 9
    "    return new Store();", // 10
    "  }", // 11
    "}", // 12
  ];
  const chunks = await chunksOf("store.js", "javascript", ...source);
  expect(chunks.map(describeChunk)).toEqual(["class:Store@1-5", "method:Store.put@6-8", "method:Store.of@9-11"]);
  expect(byName(chunks, "Store").content).toContain("constructor");
  expect(byName(chunks, "Store.put").parentId).toBe(byName(chunks, "Store").id);
  expect((await chunksOf("store.js", "javascript", ...source)).map((c) => c.id)).toEqual(chunks.map((c) => c.id));
});

test("a small class stays one chunk with no method chunks and no parent links", async () => {
  const chunks = await chunksOf("small.ts", "typescript", "class Tiny {", "  a() {}", "  b() {}", "  c() {}", "}");
  expect(chunks.map(describeChunk)).toEqual(["class:Tiny@1-5"]);
  expect(chunks[0]?.parentId).toBeUndefined();
  expect(chunks[0]?.containerName).toBeUndefined();
});

test("methods that share lines with the header or each other keep the class whole", async () => {
  const sameLine = await chunksOf(
    "w.ts",
    "typescript",
    "class W {",
    "  x = 1;",
    "  y = 2;",
    "  a() {} b() {}",
    "  c() {}",
    "  d() {}",
    "}",
  );
  expect(sameLine.map(describeChunk)).toEqual(["class:W@1-7"]);
  const header = await chunksOf(
    "h.ts",
    "typescript",
    "class H { a() {}",
    "  b() {}",
    "  c() {}",
    "  d() {}",
    "  e() {}",
    "}",
  );
  expect(header.map(describeChunk)).toEqual(["class:H@1-6"]);
});

test("a Python class with decorators, a nested class and nested defs", async () => {
  const chunks = await chunksOf(
    "jobs.py",
    "python",
    "import os", // 1
    "", // 2
    "@dataclass", // 3
    "class Job:", // 4
    '    """A unit of work."""', // 5
    "    retries = 3", // 6
    "", // 7
    "    class Meta:", // 8
    '        table = "jobs"', // 9
    "", // 10
    "        def label(self):", // 11
    "            return 1", // 12
    "", // 13
    "        def other(self):", // 14
    "            return 2", // 15
    "", // 16
    "    @staticmethod", // 17
    "    def make(name):", // 18
    "        def inner():", // 19
    "            return name", // 20
    "        return Job(inner())", // 21
    "", // 22
    "    @property", // 23
    "    def title(self):", // 24
    "        return 1", // 25
  );
  expect(chunks.map(describeChunk)).toEqual([
    "class:Job@3-6",
    "class:Job.Meta@8-9",
    "method:Job.Meta.label@11-12",
    "method:Job.Meta.other@14-15",
    "method:Job.make@17-21",
    "method:Job.title@23-25",
  ]);
  const job = byName(chunks, "Job");
  const meta = byName(chunks, "Job.Meta");
  expect(job.content.startsWith("@dataclass\nclass Job:")).toBe(true);
  expect(job.content).not.toContain("def ");
  expect(meta.parentId).toBe(job.id);
  expect(meta.containerName).toBe("Job");
  expect(byName(chunks, "Job.Meta.label").parentId).toBe(meta.id);
  expect(byName(chunks, "Job.Meta.label").containerName).toBe("Job.Meta");
  expect(byName(chunks, "Job.make").parentId).toBe(job.id);
  expect(byName(chunks, "Job.make").content.startsWith("    @staticmethod")).toBe(true);
  // A function never becomes a container: its nested def stays inside it.
  expect(chunks.some((c) => c.name?.includes("inner"))).toBe(false);
});

test("a TypeScript namespace is a container of its declarations, nested ones included", async () => {
  const chunks = await chunksOf(
    "ns.ts",
    "typescript",
    "export namespace Shapes {", // 1
    "  export const PI = 3;", // 2
    "  export function area(r: number): number {", // 3
    "    return PI * r * r;", // 4
    "  }", // 5
    "  export class Box {", // 6
    "    w = 1;", // 7
    "    h = 2;", // 8
    "    size() {", // 9
    "      return this.w * this.h;", // 10
    "    }", // 11
    "    grow() {", // 12
    "      this.w++;", // 13
    "    }", // 14
    "  }", // 15
    "  export namespace Inner { export const X = 1; }", // 16
    "}", // 17
    "declare module 'ext' {", // 18
    "  export function a(): void;", // 19
    "  export function b(): void;", // 20
    "  export function c(): void;", // 21
    "  export function d(): void;", // 22
    "  export function e(): void;", // 23
    "}", // 24
  );
  expect(chunks.map(describeChunk)).toEqual([
    "section:Shapes@1-1",
    "config:Shapes.PI@2-2",
    "function:Shapes.area@3-5",
    "class:Shapes.Box@6-8",
    "method:Shapes.Box.size@9-11",
    "method:Shapes.Box.grow@12-14",
    "section:Shapes.Inner@16-16",
    "section:ext@18-18",
    "function:ext.a@19-19",
    "function:ext.b@20-20",
    "function:ext.c@21-21",
    "function:ext.d@22-22",
    "function:ext.e@23-23",
  ]);
  const shapes = byName(chunks, "Shapes");
  const box = byName(chunks, "Shapes.Box");
  expect(byName(chunks, "Shapes.area").parentId).toBe(shapes.id);
  expect(box.parentId).toBe(shapes.id);
  expect(byName(chunks, "Shapes.Box.size").parentId).toBe(box.id);
  expect(byName(chunks, "Shapes.Box.size").containerName).toBe("Shapes.Box");
  expect(byName(chunks, "Shapes.Inner").parentId).toBe(shapes.id);
  expect(byName(chunks, "ext.a").containerName).toBe("ext");
});

test("a small namespace stays one chunk", async () => {
  const chunks = await chunksOf("n.ts", "typescript", "namespace N {", "  export function f() {}", "}");
  expect(chunks.map(describeChunk)).toEqual(["section:N@1-3"]);
});

test("the invariant holds across the webhook-service fixture", async () => {
  const root = join(import.meta.dir, "../fixtures/webhook-service");
  const { files } = await scanRepository(root);
  for (const path of files) {
    const language = classifyFile(path).language;
    if (language !== "typescript" && language !== "javascript") continue;
    const { chunks } = await analyzeFile({ path, source: await readFile(join(root, path), "utf8") }, language);
    expectContainerInvariants(chunks);
  }
});
