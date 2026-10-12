// Release gates over an offline evaluation. Thresholds are plain fractions and sit a little below the measurement they
// come from (docs/evaluation.md, "Release gates"), so a real regression fails and one re-recorded task does not.
// Change a threshold only with a written reason in the same PR.

import type { Aggregate, EvalOutput, Mode, SplitKey } from "./runner.ts";

type GateSplit = Exclude<SplitKey, "all">;

/**
 * Measured at retrieval-v4, recording on main at 676e65b (pooled required recall; precision and size reduction are
 * means over tasks):
 *   no-jev  tuning 33/33 recall, 14.8% precision | heldout 16/20 recall, 11.9% precision
 *   jev     tuning 30/33 recall, 63.1% precision | heldout 15/20 recall, 54.6% precision; size reduction about 90%
 */
export const THRESHOLDS = {
  jevRecall: { tuning: 0.85, heldout: 0.7 },
  jevPrecision: { tuning: 0.55, heldout: 0.45 },
  jevSizeReduction: { tuning: 0.8, heldout: 0.8 },
  /** No-jev recall is the candidate-recall proxy: what Jev could at best keep. */
  noJevRecall: { tuning: 0.95, heldout: 0.75 },
} as const;

export interface GateResult {
  name: string;
  /** The measured value, or null when it is missing. */
  measured: number | null;
  /** The threshold as a plain fraction; for the comparison gate, the no-jev precision the jev value must exceed. */
  threshold: number | null;
  pass: boolean;
  /** Present when the gate failed because an aggregate or value was missing. */
  message?: string;
}

const SPLITS: readonly GateSplit[] = ["tuning", "heldout"];

function aggregateOf(output: EvalOutput, mode: Mode, split: GateSplit): Aggregate | undefined {
  return output.results.aggregates[mode]?.[split];
}

function floor(name: string, value: number | null | undefined, threshold: number, missing: string): GateResult {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { name, measured: null, threshold, pass: false, message: missing };
  }
  return { name, measured: value, threshold, pass: value >= threshold };
}

/** Checks every release gate against one evaluation. A missing aggregate or value fails; it never passes. */
export function checkGates(output: EvalOutput): GateResult[] {
  const results: GateResult[] = [];
  for (const split of SPLITS) {
    const jev = aggregateOf(output, "jev", split);
    const noJev = aggregateOf(output, "no-jev", split);
    const missingJev = `no jev ${split} aggregate or value in the evaluation`;
    const missingNoJev = `no no-jev ${split} aggregate or value in the evaluation`;

    results.push(
      floor(`jev ${split} pooled required recall`, jev?.recall.micro, THRESHOLDS.jevRecall[split], missingJev),
      floor(`jev ${split} mean precision`, jev?.precision.macro, THRESHOLDS.jevPrecision[split], missingJev),
      floor(
        `jev ${split} mean size reduction`,
        jev?.sizeReduction.macro,
        THRESHOLDS.jevSizeReduction[split],
        missingJev,
      ),
      floor(`no-jev ${split} pooled required recall`, noJev?.recall.micro, THRESHOLDS.noJevRecall[split], missingNoJev),
    );

    const name = `jev ${split} mean precision exceeds no-jev`;
    const jevPrecision = jev?.precision.macro;
    const noJevPrecision = noJev?.precision.macro;
    if (
      jevPrecision === null ||
      jevPrecision === undefined ||
      noJevPrecision === null ||
      noJevPrecision === undefined
    ) {
      results.push({
        name,
        measured: jevPrecision ?? null,
        threshold: noJevPrecision ?? null,
        pass: false,
        message: `missing jev or no-jev ${split} mean precision`,
      });
    } else {
      results.push({ name, measured: jevPrecision, threshold: noJevPrecision, pass: jevPrecision > noJevPrecision });
    }
  }
  return results;
}
