import { MIN_RELEVANCE } from "../config.ts";
import { byLocation, renderText } from "../output/text.ts";
import type { ScopeMode, ScopeResult, SelectedChunk, TokenEstimator } from "../types.ts";

/** Nothing scored high enough, or nothing fit the budget, so there is no useful output to print. */
export class EmptySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptySelectionError";
  }
}

export interface SelectionOptions {
  task: string;
  mode: ScopeMode;
  budget: number;
  estimator: TokenEstimator;
  minScore?: number;
}

/** Highest score per estimated token first; ties break by path, range, then ID so output is deterministic. */
function compareByDensity(estimator: TokenEstimator) {
  const density = (item: SelectedChunk) => item.score / Math.max(estimator.count(item.chunk.content), 1);
  return (a: SelectedChunk, b: SelectedChunk) => density(b) - density(a) || byLocation(a, b);
}

/**
 * Greedily includes candidates (best score-per-token first) while the full rendered artifact, not just chunk
 * bodies, still fits the budget. Candidates below the minimum score are dropped.
 */
export function selectWithinBudget(candidates: readonly SelectedChunk[], options: SelectionOptions): ScopeResult {
  const { task, mode, budget, estimator, minScore = MIN_RELEVANCE } = options;
  const eligible = candidates.filter((item) => item.score >= minScore).sort(compareByDensity(estimator));
  if (eligible.length === 0) {
    throw new EmptySelectionError(`No candidate scored at least ${minScore}; nothing relevant to select.`);
  }

  const chosen: SelectedChunk[] = [];
  for (const item of eligible) {
    if (estimator.count(renderText(task, [...chosen, item])) <= budget) chosen.push(item);
  }
  if (chosen.length === 0) {
    throw new EmptySelectionError(`No relevant chunk fits the budget of ${budget} estimated tokens; raise --budget.`);
  }

  const text = renderText(task, chosen);
  const skipped = eligible.length - chosen.length;
  return {
    schemaVersion: 1,
    mode,
    task,
    budget,
    estimator: estimator.id,
    estimatedTokens: estimator.count(text),
    characters: text.length,
    lines: text.split("\n").length,
    chunks: [...chosen].sort(byLocation),
    warnings: skipped > 0 ? [`${skipped} relevant chunk(s) were left out to stay within the budget.`] : [],
  };
}
