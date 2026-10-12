// Evaluation metrics as pure functions (docs/scope-implementation-plan.md, "Evaluation metric definitions").
// All sizes are characters. Ratios that have no denominator are `null` and reported as "n/a", never as 0 or 1.

import { coverMatches, isCovered, lineSetsOf, type LineRange, type LineSets } from "./matching.ts";

/** The labeled units of one task, resolved to line ranges. */
export interface LabeledUnits {
  required: LineRange[];
  useful: LineRange[];
  irrelevant: LineRange[];
}

export interface Ratio {
  count: number;
  total: number;
  /** `count / total`, or null when `total` is 0. */
  value: number | null;
}

const ratio = (count: number, total: number): Ratio => ({ count, total, value: total === 0 ? null : count / total });

/** Required recall: covered required units / required units. */
export function requiredRecall(required: readonly LineRange[], selected: readonly LineRange[]): Ratio {
  const lines = lineSetsOf(selected);
  return ratio(required.filter((unit) => isCovered(unit, lines)).length, required.length);
}

/**
 * Precision: selected chunks that cover-match a required or useful unit / selected chunks. With nothing selected it is
 * undefined (`value` null).
 */
export function precision(selected: readonly LineRange[], units: LabeledUnits): Ratio {
  const wanted = [...units.required, ...units.useful];
  const matched = selected.filter((chunk) => wanted.some((unit) => coverMatches(chunk, unit))).length;
  return ratio(matched, selected.length);
}

/** Characters of one line of a file, newline included, so that a whole file adds up to its length. */
export type LineWeights = (file: string, line: number) => number;

export interface CharacterShares {
  /** Characters of the distinct selected lines. */
  selectedChars: number;
  /** Selected characters inside irrelevant units, not counting lines that a required or useful unit also holds. */
  irrelevantChars: number;
  /** Selected characters inside no labeled unit at all. */
  unlabeledChars: number;
  /** `irrelevantChars / selectedChars`, null when nothing was selected. */
  irrelevantRate: number | null;
  /** `unlabeledChars / selectedChars`, null when nothing was selected. */
  unlabeledShare: number | null;
}

const inAny = (ranges: readonly LineRange[], file: string, line: number) =>
  ranges.some((range) => range.file === file && line >= range.startLine && line <= range.endLine);

/**
 * Splits the selected characters into irrelevant, unlabeled and (the rest) wanted. A line counts once however many
 * chunks selected it. A line inside both a required or useful unit and an irrelevant one (an irrelevant container
 * around a required member) counts as wanted: the label that makes it needed wins.
 */
export function characterShares(selected: LineSets, units: LabeledUnits, weight: LineWeights): CharacterShares {
  const wanted = [...units.required, ...units.useful];
  let selectedChars = 0;
  let irrelevantChars = 0;
  let unlabeledChars = 0;
  for (const [file, lines] of [...selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const line of lines) {
      const chars = weight(file, line);
      selectedChars += chars;
      if (inAny(wanted, file, line)) continue;
      if (inAny(units.irrelevant, file, line)) irrelevantChars += chars;
      else unlabeledChars += chars;
    }
  }
  return {
    selectedChars,
    irrelevantChars,
    unlabeledChars,
    irrelevantRate: selectedChars === 0 ? null : irrelevantChars / selectedChars,
    unlabeledShare: selectedChars === 0 ? null : unlabeledChars / selectedChars,
  };
}

/** Size reduction: `1 - selected / eligible` source characters. Output-format overhead is not included. */
export function sizeReduction(selectedChars: number, eligibleChars: number): number | null {
  return eligibleChars === 0 ? null : 1 - selectedChars / eligibleChars;
}

/** One side of a paired comparison on a single task. */
export interface PairedSide {
  recall: number | null;
  precision: number | null;
  selectedChars: number;
}

export interface PairedDifference {
  /** jev minus no-jev; null when either side is undefined. */
  recall: number | null;
  precision: number | null;
  selectedChars: number;
}

const difference = (jev: number | null, base: number | null) => (jev === null || base === null ? null : jev - base);

/** Jev impact on one task: the Jev result minus the no-Jev result, on the same task and snapshot. */
export function pairedDifference(jev: PairedSide, noJev: PairedSide): PairedDifference {
  return {
    recall: difference(jev.recall, noJev.recall),
    precision: difference(jev.precision, noJev.precision),
    selectedChars: jev.selectedChars - noJev.selectedChars,
  };
}

/** Arithmetic mean of the defined values; null when there are none. */
export function mean(values: readonly (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length === 0 ? null : defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

export interface Spread {
  min: number;
  mean: number;
  max: number;
}

/** Minimum, mean and maximum of the defined values; null when there are none. */
export function spread(values: readonly (number | null)[]): Spread | null {
  const defined = values.filter((value): value is number => value !== null);
  const average = mean(defined);
  return average === null || defined.length === 0
    ? null
    : { min: Math.min(...defined), mean: average, max: Math.max(...defined) };
}
