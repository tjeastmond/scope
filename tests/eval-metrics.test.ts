import { describe, expect, test } from "bun:test";
import { lineSetsOf } from "../scripts/eval/matching.ts";
import {
  characterShares,
  mean,
  pairedDifference,
  precision,
  requiredRecall,
  sizeReduction,
  spread,
  type LabeledUnits,
} from "../scripts/eval/metrics.ts";

const range = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

// Required A (a:1-10) and B (a:21-30), useful U (b:1-4), irrelevant I (a:41-50).
const units: LabeledUnits = {
  required: [range("a.ts", 1, 10), range("a.ts", 21, 30)],
  useful: [range("b.ts", 1, 4)],
  irrelevant: [range("a.ts", 41, 50)],
};
const selected = [
  range("a.ts", 1, 10), // is A
  range("a.ts", 21, 27), // 7 of B's 10 lines: matches B (inside it) but does not cover it (70%)
  range("a.ts", 41, 45), // inside the irrelevant unit
  range("b.ts", 1, 4), // is U
  range("z.ts", 1, 5), // unlabeled
];
const tenPerLine = () => 10;

describe("metrics", () => {
  test("required recall is covered required units over required units", () => {
    expect(requiredRecall(units.required, selected)).toEqual({ count: 1, total: 2, value: 0.5 });
    expect(requiredRecall(units.required, [])).toEqual({ count: 0, total: 2, value: 0 });
    expect(requiredRecall([], selected).value).toBeNull();
  });

  test("precision counts selected chunks that cover-match a required or useful unit", () => {
    expect(precision(selected, units)).toEqual({ count: 3, total: 5, value: 0.6 });
  });

  test("precision is undefined, not 0 or 1, when nothing is selected", () => {
    expect(precision([], units)).toEqual({ count: 0, total: 0, value: null });
  });

  test("character shares split selected characters into irrelevant and unlabeled", () => {
    // 10 + 7 + 5 + 4 + 5 = 31 distinct selected lines at 10 characters each.
    expect(characterShares(lineSetsOf(selected), units, tenPerLine)).toEqual({
      selectedChars: 310,
      irrelevantChars: 50,
      unlabeledChars: 50,
      irrelevantRate: 50 / 310,
      unlabeledShare: 50 / 310,
    });
  });

  test("a line selected twice counts once, and a wanted line inside an irrelevant unit is not irrelevant", () => {
    const shares = characterShares(
      lineSetsOf([range("a.ts", 1, 10), range("a.ts", 5, 12)]),
      { required: [range("a.ts", 1, 10)], useful: [], irrelevant: [range("a.ts", 1, 20)] },
      tenPerLine,
    );
    expect(shares.selectedChars).toBe(120);
    expect(shares.irrelevantChars).toBe(20);
    expect(shares.unlabeledChars).toBe(0);
  });

  test("shares are undefined when nothing is selected", () => {
    const shares = characterShares(lineSetsOf([]), units, tenPerLine);
    expect(shares).toMatchObject({ selectedChars: 0, irrelevantRate: null, unlabeledShare: null });
  });

  test("size reduction is 1 minus selected over eligible characters", () => {
    expect(sizeReduction(310, 1000)).toBeCloseTo(0.69, 10);
    expect(sizeReduction(0, 1000)).toBe(1);
    expect(sizeReduction(10, 0)).toBeNull();
  });

  test("Jev impact is the paired difference, jev minus no-jev", () => {
    expect(
      pairedDifference(
        { recall: 1, precision: 0.5, selectedChars: 300 },
        { recall: 0.5, precision: 0.25, selectedChars: 1000 },
      ),
    ).toEqual({ recall: 0.5, precision: 0.25, selectedChars: -700 });
    expect(
      pairedDifference(
        { recall: 1, precision: null, selectedChars: 0 },
        { recall: 1, precision: 0.5, selectedChars: 9 },
      ),
    ).toEqual({ recall: 0, precision: null, selectedChars: -9 });
  });

  test("mean and spread skip undefined values", () => {
    expect(mean([1, null, 3])).toBe(2);
    expect(mean([null])).toBeNull();
    expect(spread([4, null, 2, 6])).toEqual({ min: 2, mean: 4, max: 6 });
    expect(spread([])).toBeNull();
  });
});
