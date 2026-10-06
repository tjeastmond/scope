import { mergeRegions, toScopeRegion } from "../../src/context/regions.ts";
import { byLocation, renderResult } from "../../src/output/text.ts";
import { heuristicEstimator } from "../../src/context/tokens.ts";
import type { ScopeResult, SelectedChunk } from "../../src/types.ts";

/**
 * The text artifact holding exactly these chunks (no skips, warnings or unmet requirements), with the embedded size

 * numbers settled to a fixed point the way selection does, so its size equals what selection measures for that set.
 */
export function renderText(task: string, chunks: readonly SelectedChunk[], budget = 100): string {
  const sorted = [...chunks].sort(byLocation);
  let metrics = { estimatedTokens: 0, characters: 0, lines: 1 };
  for (let round = 0; round < 20; round++) {
    const result: ScopeResult = {
      schemaVersion: 1,
      mode: "jev",
      task,
      budget,
      estimator: heuristicEstimator.id,
      ...metrics,
      chunks: sorted,
      regions: mergeRegions(sorted).map(toScopeRegion),
      warnings: [],
      unmetCoherence: [],
      skipped: [],
    };
    const text = renderResult(result);
    const next = {
      estimatedTokens: heuristicEstimator.count(text),
      characters: text.length,
      lines: text.split("\n").length,
    };
    if (JSON.stringify(next) === JSON.stringify(metrics)) return text;
    metrics = next;
  }
  throw new Error("embedded metrics did not settle");
}
