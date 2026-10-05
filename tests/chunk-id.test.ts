import { expect, test } from "bun:test";
import { makeChunkId } from "../src/chunk-id.ts";

const base = { file: "src/a.ts", startLine: 3, endLine: 9, kind: "function", name: "run" } as const;

test("is stable for unchanged source", () => {
  expect(makeChunkId(base)).toBe(makeChunkId({ ...base }));
  expect(makeChunkId(base)).toMatch(/^[0-9a-f]{12}$/);
});

test("changes when the range moves", () => {
  expect(makeChunkId({ ...base, startLine: 4, endLine: 10 })).not.toBe(makeChunkId(base));
});

test("disambiguates duplicate names in different files", () => {
  expect(makeChunkId({ ...base, file: "src/b.ts" })).not.toBe(makeChunkId(base));
});

test("disambiguates duplicate names in one file by range and kind", () => {
  const second = { ...base, startLine: 20, endLine: 25 };
  expect(makeChunkId(second)).not.toBe(makeChunkId(base));
  expect(makeChunkId({ ...base, kind: "method" })).not.toBe(makeChunkId(base));
});

test("handles unnamed chunks", () => {
  const unnamed = { file: base.file, startLine: 1, endLine: 2, kind: "file" } as const;
  expect(makeChunkId(unnamed)).toMatch(/^[0-9a-f]{12}$/);
});
