// Matching policy for evaluation: how a labeled context unit (a chunk line range) is judged covered by a selection.
// Selections are compared by lines, so merged regions and split chunks are handled without caring how the output was cut.

/** A labeled unit is covered when the selection holds at least this share of its lines (docs/evaluation.md). */
export const COVERAGE_THRESHOLD = 0.8;

/** A line range of one file, 1-based and inclusive: a resolved label, or a selected chunk. */
export interface LineRange {
  file: string;
  startLine: number;
  endLine: number;
}

/** The selected lines of every file. */
export type LineSets = Map<string, Set<number>>;

const size = (range: LineRange) => range.endLine - range.startLine + 1;

/** The union of the given ranges as a set of line numbers per file. */
export function lineSetsOf(ranges: readonly LineRange[]): LineSets {
  const sets: LineSets = new Map();
  for (const { file, startLine, endLine } of ranges) {
    let lines = sets.get(file);
    if (!lines) sets.set(file, (lines = new Set()));
    for (let line = startLine; line <= endLine; line++) lines.add(line);
  }
  return sets;
}

/** How many of the unit's lines are in the selection. */
export function coveredLines(unit: LineRange, selected: LineSets): number {
  const lines = selected.get(unit.file);
  if (!lines) return 0;
  let count = 0;
  for (let line = unit.startLine; line <= unit.endLine; line++) if (lines.has(line)) count++;
  return count;
}

/** True when the selection contains at least {@link COVERAGE_THRESHOLD} of the unit's lines. */
export function isCovered(unit: LineRange, selected: LineSets): boolean {
  return size(unit) > 0 && coveredLines(unit, selected) / size(unit) >= COVERAGE_THRESHOLD;
}

/**
 * True when a selected chunk and a labeled unit cover-match, in either direction: the chunk lies at least
 * {@link COVERAGE_THRESHOLD} inside the unit (the chunk is the unit or a part of it), or the chunk holds at least that
 * share of the unit (the chunk is the unit or a parent of it).
 */
export function coverMatches(chunk: LineRange, unit: LineRange): boolean {
  if (chunk.file !== unit.file) return false;
  const overlap = Math.min(chunk.endLine, unit.endLine) - Math.max(chunk.startLine, unit.startLine) + 1;
  if (overlap <= 0) return false;
  return overlap / size(chunk) >= COVERAGE_THRESHOLD || overlap / size(unit) >= COVERAGE_THRESHOLD;
}
