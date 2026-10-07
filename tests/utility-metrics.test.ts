import { describe, expect, test } from "bun:test";
import { blendScores, evaluateSelection, summarize } from "../scripts/utility-metrics.ts";

const charsById = new Map([
  ["r1", 100],
  ["r2", 100],
  ["u1", 50],
  ["i1", 30],
  ["x1", 20],
  ["s1", 10],
]);
const base = {
  required: [["r1"], ["r2", "r2b"]],
  usefulIds: new Set(["u1"]),
  irrelevantIds: new Set(["i1"]),
  charsById,
  baselineChars: 310,
};

describe("evaluateSelection", () => {
  test("recall counts a required label as found when any chunk it resolves to is selected", () => {
    expect(evaluateSelection({ ...base, selectedIds: new Set(["r1", "r2b"]) }).recall).toBe(1);
    expect(evaluateSelection({ ...base, selectedIds: new Set(["r1"]) }).recall).toBe(0.5);
    expect(evaluateSelection({ ...base, selectedIds: new Set() }).recall).toBe(0);
  });

  test("precision is good over labeled; unlabeled chunks are counted apart and do not affect it", () => {
    const e = evaluateSelection({ ...base, selectedIds: new Set(["r1", "u1", "i1", "x1", "s1"]) });
    expect(e.precision).toBeCloseTo(2 / 3, 10);
    expect(e.irrelevantSelected).toBe(1);
    expect(e.unlabeledSelected).toBe(2);
    expect(e.selectedCount).toBe(5);
  });

  test("precision is undefined when nothing selected carries a label; useful recall is over useful labels", () => {
    const e = evaluateSelection({ ...base, selectedIds: new Set(["x1"]) });
    expect(e.precision).toBeUndefined();
    expect(e.usefulRecall).toBe(0);
    expect(evaluateSelection({ ...base, selectedIds: new Set(["u1"]) }).usefulRecall).toBe(1);
  });

  test("size reduction compares selected characters with the baseline", () => {
    const e = evaluateSelection({ ...base, selectedIds: new Set(["r1", "u1"]) });
    expect(e.selectedChars).toBe(150);
    expect(e.sizeReduction).toBeCloseTo(1 - 150 / 310, 10);
    expect(evaluateSelection({ ...base, baselineChars: 0, selectedIds: new Set() }).sizeReduction).toBe(0);
  });
});

describe("blendScores", () => {
  test("adds the weighted deterministic score normalized by the run's maximum", () => {
    expect(blendScores([0.5, 0.4], [0.5, 0.25], 0.2)).toEqual([0.7, 0.5]);
  });

  test("weight 0 or an all-zero deterministic score leaves Jev's relevance unchanged", () => {
    expect(blendScores([0.5, 0.4], [1, 2], 0)).toEqual([0.5, 0.4]);
    expect(blendScores([0.5], [0], 0.2)).toEqual([0.5]);
  });
});

test("summarize gives mean and range of the defined values", () => {
  expect(summarize([1, undefined, 3])).toEqual({ mean: 2, min: 1, max: 3, n: 2 });
  expect(summarize([undefined])).toBeUndefined();
});
