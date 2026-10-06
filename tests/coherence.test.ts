import { expect, test } from "bun:test";
import { requiredSupports } from "../src/context/coherence.ts";
import type { ChunkKind, CodeChunk, Reference } from "../src/types.ts";

const chunk = (
  id: string,
  kind: ChunkKind,
  extra: Partial<CodeChunk> = {},
  file = "a.ts",
  startLine = 1,
): CodeChunk => ({
  id,
  file,
  language: "typescript",
  kind,
  name: id,
  startLine,
  endLine: startLine + 2,
  content: `// ${id}`,
  references: [],
  ...extra,
});

const ref = (kind: Reference["kind"], targetChunkId: string, evidence: Reference["evidence"] = "exact"): Reference => ({
  kind,
  from: { file: "a.ts", line: 1 },
  name: targetChunkId,
  targetChunkId,
  evidence,
});

const lookupOf = (...chunks: CodeChunk[]) => new Map(chunks.map((c) => [c.id, c]));
const ids = (chunks: CodeChunk[]) => chunks.map((c) => c.id);

test("a method needs its container header chain, nearest header first", () => {
  const outer = chunk("Outer", "class");
  const inner = chunk("Outer.Inner", "class", { parentId: "Outer" }, "a.ts", 10);
  const method = chunk("Outer.Inner.run", "method", { parentId: "Outer.Inner" }, "a.ts", 20);
  expect(ids(requiredSupports(method, lookupOf(outer, inner, method)))).toEqual(["Outer.Inner", "Outer"]);
});

test("exact type, extends and implements targets are required", () => {
  const shape = chunk("Shape", "interface", {}, "shape.ts");
  const base = chunk("Base", "class", {}, "base.ts");
  const alias = chunk("Alias", "type", {}, "alias.ts");
  const user = chunk("User", "function", {
    references: [ref("type", "Alias"), ref("extends", "Base"), ref("implements", "Shape")],
  });
  expect(ids(requiredSupports(user, lookupOf(shape, base, alias, user)))).toEqual(["Alias", "Base", "Shape"]);
});

test("heuristic, unresolved and absent evidence are ignored", () => {
  const alias = chunk("Alias", "type");
  const user = chunk("User", "function", {
    references: [
      ref("type", "Alias", "heuristic"),
      ref("type", "Alias", "unresolved"),
      { ...ref("type", "Alias"), evidence: undefined },
    ],
  });
  expect(requiredSupports(user, lookupOf(alias, user))).toEqual([]);
});

test("calls, imports, styles and tests are not supports even when exact", () => {
  const target = chunk("Target", "class");
  const user = chunk("User", "function", {
    references: [ref("call", "Target"), ref("import", "Target"), ref("style", "Target"), ref("test", "Target")],
  });
  expect(requiredSupports(user, lookupOf(target, user))).toEqual([]);
});

test("only type, interface and class targets count", () => {
  const fn = chunk("helper", "function");
  const config = chunk("CONFIG", "config");
  const user = chunk("User", "function", { references: [ref("type", "helper"), ref("type", "CONFIG")] });
  expect(requiredSupports(user, lookupOf(fn, config, user))).toEqual([]);
});

test("missing ids are skipped and a chunk never requires itself", () => {
  const method = chunk("m", "method", { parentId: "gone", references: [ref("type", "m"), ref("type", "absent")] });
  expect(requiredSupports(method, lookupOf(method))).toEqual([]);
});

test("a parent cycle terminates and excludes the chunk itself", () => {
  const a = chunk("A", "class", { parentId: "B" });
  const b = chunk("B", "class", { parentId: "A" });
  expect(ids(requiredSupports(a, lookupOf(a, b)))).toEqual(["B"]);
});

test("supports of supports are not chased and duplicates collapse", () => {
  const deep = chunk("Deep", "type");
  const alias = chunk("Alias", "type", { references: [ref("type", "Deep")] });
  const user = chunk("User", "function", { references: [ref("type", "Alias"), ref("extends", "Alias")] });
  expect(ids(requiredSupports(user, lookupOf(deep, alias, user)))).toEqual(["Alias"]);
});

test("the order is headers first, then reference targets by location, independent of reference order", () => {
  const header = chunk("Header", "class", {}, "z.ts");
  const first = chunk("First", "type", {}, "a.ts", 1);
  const second = chunk("Second", "type", {}, "a.ts", 9);
  const forward = chunk("m", "method", {
    parentId: "Header",
    references: [ref("type", "First"), ref("type", "Second")],
  });
  const reversed = { ...forward, references: [...forward.references].reverse() };
  const lookup = lookupOf(header, first, second, forward);
  expect(ids(requiredSupports(forward, lookup))).toEqual(["Header", "First", "Second"]);
  expect(requiredSupports(reversed, lookup)).toEqual(requiredSupports(forward, lookup));
});
