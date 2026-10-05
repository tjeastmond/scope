import { expect, test } from "bun:test";
import type { CodeChunk } from "../src/types.ts";
import { JevResponseError } from "../src/jev/errors.ts";
import { validateJudgments, validateRelevance } from "../src/jev/validate.ts";

const answer = (noul: unknown) => ({ type: "noul", noul });

test("returns judgments in candidate order, accepting the 0 and 1 bounds", () => {
  const judgments = validateRelevance(["b", "a"], { a: answer(0), b: answer(1) });
  expect(judgments.map(({ chunkId, relevance }) => ({ chunkId, relevance }))).toEqual([
    { chunkId: "b", relevance: 1 },
    { chunkId: "a", relevance: 0 },
  ]);
});

test("rejects a missing answer", () => {
  expect(() => validateRelevance(["a", "b"], { a: answer(0.5) })).toThrow(/no answer for candidate b/);
});

test("rejects answers for unknown candidates", () => {
  expect(() => validateRelevance(["a"], { a: answer(0.5), z: answer(0.5) })).toThrow(/unknown candidates: z/);
});

test("rejects duplicate submitted IDs", () => {
  expect(() => validateRelevance(["a", "a"], { a: answer(0.5) })).toThrow(/Duplicate candidate IDs/);
});

test.each([
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["below range", -0.1],
  ["above range", 1.01],
  ["a string", "0.5"],
  ["missing", undefined],
  ["null", null],
])("rejects an invalid relevance: %s", (_label, value) => {
  expect(() => validateRelevance(["a"], { a: answer(value) })).toThrow(JevResponseError);
});

test("rejects a malformed answer object", () => {
  expect(() => validateRelevance(["a"], { a: null })).toThrow(JevResponseError);
  expect(() => validateRelevance(["a"], { a: 0.5 })).toThrow(JevResponseError);
});

test("does not read inherited properties as answers", () => {
  expect(() => validateRelevance(["toString"], {})).toThrow(/no answer for candidate toString/);
});

const candidate = (id: string) => ({ id }) as CodeChunk;

test("validateJudgments requires exactly one in-range judgment per candidate", () => {
  const candidates = [candidate("a"), candidate("b")];
  expect(
    validateJudgments(candidates, [
      { chunkId: "b", relevance: 0.2 },
      { chunkId: "a", relevance: 1 },
    ]),
  ).toEqual(
    new Map([
      ["b", 0.2],
      ["a", 1],
    ]),
  );
  expect(() => validateJudgments(candidates, [])).toThrow(/Missing judgments for 2/);
  expect(() => validateJudgments(candidates, [{ chunkId: "a", relevance: 1 }])).toThrow(/Missing judgments for 1/);
  expect(() => validateJudgments(candidates, [{ chunkId: "z", relevance: 1 }])).toThrow(/unknown candidate z/);
  expect(() =>
    validateJudgments(candidates, [
      { chunkId: "a", relevance: 1 },
      { chunkId: "a", relevance: 1 },
    ]),
  ).toThrow(/Duplicate judgment/);
  expect(() => validateJudgments(candidates, [{ chunkId: "a", relevance: Number.NaN }])).toThrow(/Invalid relevance/);
  expect(() => validateJudgments(candidates, [{ chunkId: "a", relevance: 2 }])).toThrow(JevResponseError);
});
