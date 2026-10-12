import { describe, expect, test } from "bun:test";
import { COVERAGE_THRESHOLD, coverMatches, coveredLines, isCovered, lineSetsOf } from "../scripts/eval/matching.ts";

const range = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });
const unit = range("a.ts", 1, 100);

describe("coverage matching", () => {
  test("the threshold is 80%", () => {
    expect(COVERAGE_THRESHOLD).toBe(0.8);
  });

  test("an exact match is covered", () => {
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 100)]))).toBe(true);
  });

  test("a merged parent region covers the unit", () => {
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 400)]))).toBe(true);
  });

  test("adjacent chunks that split the unit together cover it", () => {
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 50), range("a.ts", 51, 100)]))).toBe(true);
  });

  test("a split partial is covered at 80% and 81% but not at 79%", () => {
    expect(coveredLines(unit, lineSetsOf([range("a.ts", 1, 79)]))).toBe(79);
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 79)]))).toBe(false);
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 80)]))).toBe(true);
    expect(isCovered(unit, lineSetsOf([range("a.ts", 1, 81)]))).toBe(true);
  });

  test("covered lines count wherever they sit in the unit", () => {
    expect(isCovered(unit, lineSetsOf([range("a.ts", 21, 100)]))).toBe(true);
    expect(isCovered(unit, lineSetsOf([range("a.ts", 22, 100)]))).toBe(false);
  });

  test("a selection in a different file covers nothing", () => {
    expect(isCovered(unit, lineSetsOf([range("b.ts", 1, 100)]))).toBe(false);
  });

  test("an empty selection covers nothing", () => {
    expect(isCovered(unit, lineSetsOf([]))).toBe(false);
  });
});

describe("chunk and unit cover-match", () => {
  test("matches in both directions at 80%", () => {
    expect(coverMatches(range("a.ts", 1, 100), unit)).toBe(true);
    expect(coverMatches(range("a.ts", 1, 400), unit)).toBe(true);
    expect(coverMatches(range("a.ts", 10, 20), unit)).toBe(true);
  });

  test("a partial overlap below 80% of both is no match", () => {
    expect(coverMatches(range("a.ts", 51, 150), unit)).toBe(false);
    expect(coverMatches(range("a.ts", 22, 121), unit)).toBe(false);
  });

  test("another file or a disjoint range never matches", () => {
    expect(coverMatches(range("b.ts", 1, 100), unit)).toBe(false);
    expect(coverMatches(range("a.ts", 101, 200), unit)).toBe(false);
  });
});
