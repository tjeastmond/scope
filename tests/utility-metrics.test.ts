import { describe, expect, test } from "bun:test";
import { mergeRegions } from "../src/context/regions.ts";
import type { CodeChunk, SelectedChunk } from "../src/types.ts";
import { blendScores, evaluateSelection, regionChars, summarize } from "../scripts/utility-metrics.ts";

const base = {
  required: [["r1"], ["r2", "r2b"]],
  usefulIds: new Set(["u1"]),
  irrelevantIds: new Set(["i1"]),
  selectedChars: 150,
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
    expect(
      evaluateSelection({ ...base, usefulIds: new Set(), selectedIds: new Set(["r1"]) }).usefulRecall,
    ).toBeUndefined();
  });

  test("size reduction compares selected characters with the baseline", () => {
    const e = evaluateSelection({ ...base, selectedIds: new Set(["r1", "u1"]) });
    expect(e.selectedChars).toBe(150);
    expect(e.sizeReduction).toBeCloseTo(1 - 150 / 310, 10);
    expect(evaluateSelection({ ...base, baselineChars: 0, selectedIds: new Set() }).sizeReduction).toBe(0);
  });
});

describe("regionChars", () => {
  const chunk = (id: string, startLine: number, endLine: number): SelectedChunk => {
    const lines = Array.from({ length: endLine - startLine + 1 }, (_, i) => `line${startLine + i}`);
    return {
      chunk: { id, file: "a.ts", language: "typescript", startLine, endLine, content: lines.join("\n") } as CodeChunk,
      signals: {},
      score: 1,
      reason: "t",
    };
  };

  test("counts overlapping and nested chunks once, as Scope emits them", () => {
    const outer = chunk("outer", 1, 3);
    const nested = chunk("nested", 2, 2);
    const overlapping = chunk("overlap", 3, 4);
    const regions = mergeRegions([outer, nested, overlapping]);
    const summed = [outer, nested, overlapping].reduce((sum, item) => sum + item.chunk.content.length, 0);
    expect(regionChars(regions)).toBe("line1\nline2\nline3\nline4".length);
    expect(regionChars(regions)).toBeLessThan(summed);
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
