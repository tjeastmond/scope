import { expect, test } from "bun:test";
import { JevResponseError } from "../src/jev/types.ts";
import { validateRelevance } from "../src/jev/validate.ts";

const answer = (noul: unknown) => ({ type: "noul", noul });

test("returns judgments in candidate order, accepting the 0 and 1 bounds", () => {
  const judgments = validateRelevance(["b", "a"], { a: answer(0), b: answer(1) });
  expect(judgments).toEqual([
    { id: "b", relevance: 1 },
    { id: "a", relevance: 0 },
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
