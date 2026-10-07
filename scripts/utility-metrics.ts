// Pure metric functions for the relevance-threshold sweep (issue #63; scripts/utility-sweep.ts). Dev code, not shipped.

export interface SelectionEvaluation {
  /** Share of required labels whose resolved chunk is selected (1 when there are no required labels). */
  recall: number;
  /** Share of useful-labeled chunks that are selected; undefined when the task has none. */
  usefulRecall: number | undefined;
  /** Selected chunks labeled required or useful, over selected chunks carrying any label; undefined if none is labeled. */
  precision: number | undefined;
  /** Selected chunks that carry no label at all. */
  unlabeledSelected: number;
  /** Selected chunks labeled irrelevant. */
  irrelevantSelected: number;
  selectedCount: number;
  selectedChars: number;
  /** 1 - selected characters / baseline characters (0 when the baseline is empty). */
  sizeReduction: number;
}

export interface EvaluationInput {
  /** Ids of every selected chunk, supporting declarations included. */
  selectedIds: ReadonlySet<string>;
  /** One entry per required label: the chunk ids it resolves to (the label is found when any is selected). */
  required: readonly (readonly string[])[];
  usefulIds: ReadonlySet<string>;
  irrelevantIds: ReadonlySet<string>;
  /** Content length by chunk id, for every chunk that can be selected. */
  charsById: ReadonlyMap<string, number>;
  /** Characters of the all-candidate baseline (`--no-jev`). */
  baselineChars: number;
}

export function evaluateSelection(input: EvaluationInput): SelectionEvaluation {
  const { selectedIds, required, usefulIds, irrelevantIds, charsById, baselineChars } = input;
  const found = required.filter((ids) => ids.some((id) => selectedIds.has(id))).length;
  const requiredIds = new Set(required.flat());
  let good = 0;
  let labeled = 0;
  let unlabeledSelected = 0;
  let irrelevantSelected = 0;
  let selectedChars = 0;
  for (const id of selectedIds) {
    selectedChars += charsById.get(id) ?? 0;
    const isGood = requiredIds.has(id) || usefulIds.has(id);
    const isBad = irrelevantIds.has(id);
    if (isGood) good += 1;
    if (isBad) irrelevantSelected += 1;
    if (isGood || isBad) labeled += 1;
    else unlabeledSelected += 1;
  }
  return {
    recall: required.length === 0 ? 1 : found / required.length,
    usefulRecall:
      usefulIds.size === 0 ? undefined : [...usefulIds].filter((id) => selectedIds.has(id)).length / usefulIds.size,
    precision: labeled === 0 ? undefined : good / labeled,
    unlabeledSelected,
    irrelevantSelected,
    selectedCount: selectedIds.size,
    selectedChars,
    sizeReduction: baselineChars === 0 ? 0 : 1 - selectedChars / baselineChars,
  };
}

/**
 * Blends Jev relevance with the deterministic retrieval total: `jev + weight * deterministic / max(deterministic)`,
 * the deterministic part normalized to [0, 1] over the run's candidates. Weight 0 returns Jev's relevance unchanged.
 */
export function blendScores(jev: readonly number[], deterministic: readonly number[], weight: number): number[] {
  const max = Math.max(0, ...deterministic);
  return jev.map((value, i) => value + (max > 0 ? (weight * (deterministic[i] ?? 0)) / max : 0));
}

export interface Summary {
  mean: number;
  min: number;
  max: number;
  /** Number of values summarized. */
  n: number;
}

/** Mean and range of the defined values; undefined when there are none. */
export function summarize(values: readonly (number | undefined)[]): Summary | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) return undefined;
  return {
    mean: defined.reduce((sum, value) => sum + value, 0) / defined.length,
    min: Math.min(...defined),
    max: Math.max(...defined),
    n: defined.length,
  };
}
