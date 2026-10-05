import { expect, test } from "bun:test";
import { CandidateLimitError, selectCandidates } from "../src/retrieval/candidates.ts";
import type { CodeChunk } from "../src/types.ts";

const chunk = (file: string, startLine: number, id: string): CodeChunk => ({
  id,
  file,
  language: "typescript",
  kind: "function",
  name: id,
  startLine,
  endLine: startLine + 1,
  content: "",
  references: [],
  estimatedTokens: 0,
});

const chunks = [chunk("b.ts", 1, "e"), chunk("a.ts", 9, "d"), chunk("a.ts", 2, "c"), chunk("a.ts", 2, "b")];

test("orders by path, start line, then ID regardless of input order", () => {
  const expected = ["b", "c", "d", "e"];
  expect(selectCandidates(chunks).map((c) => c.id)).toEqual(expected);
  expect(selectCandidates([...chunks].reverse()).map((c) => c.id)).toEqual(expected);
});

test("does not mutate its input", () => {
  const input = [...chunks];
  selectCandidates(input);
  expect(input).toEqual(chunks);
});

test("accepts exactly the cap and rejects more instead of truncating", () => {
  expect(selectCandidates(chunks, { max: 4 })).toHaveLength(4);
  expect(() => selectCandidates(chunks, { max: 3 })).toThrow(CandidateLimitError);
  expect(() => selectCandidates(chunks, { max: 3 })).toThrow(/4 chunks are eligible but at most 3/);
});

test("returns an empty list for an empty repository", () => {
  expect(selectCandidates([])).toEqual([]);
});
