// The single versioned home of every retrieval weight and cap. Nothing else hard-codes them. Overrides exist for the
// evaluation harness and tests; they are not a CLI option.

import { RetrievalConfigError } from "../errors.ts";

/** Retrieval memory (#74): a few extra candidates from similar prior tasks, appended after the fresh shortlist. */
export interface MemoryConfig {
  /** Most memory candidates added to the shortlist; 0 turns memory off. */
  maxCandidates: number;
  /** Smallest Jaccard similarity, in (0, 1], for a prior task to count as similar. */
  similarityMin: number;
  /** Newest similar prior runs considered. */
  maxRuns: number;
  /** Weight of the memory signal in a memory candidate's score, in [0, 1]. */
  weight: number;
}

export interface RetrievalConfig {
  /** Names this exact set of values; bump it on any change so evaluation results stay comparable. */
  version: string;
  /**
   * Relative weight of each ranking signal. Illustrative starting guesses to be tuned from evaluation results; the
   * defaults sum to 1.0, which keeps a total score in [0, 1], but only finiteness and non-negativity are enforced.
   */
  weights: { symbol: number; lexical: number; path: number; dependency: number; test: number; proximity: number };
  /** Maximum candidates passed on to Jev (plan target: 20-30). */
  shortlistSize: number;
  /** When the best candidate's total score is below this (in [0, 1]), the shortlist is called weak in a warning. */
  weakShortlistTotal: number;
  /** Caps for one-hop graph expansion of the strongest matches. */
  expansion: {
    /** Top-ranked chunks whose neighbors are considered. */
    seedCount: number;
    /** Neighbors taken per seed. */
    maxNeighborsPerSeed: number;
    /** Neighbors added in total, never more than the shortlist. */
    maxExpanded: number;
  };
  /** History and feedback as extra candidate signals; they add to the fresh shortlist and never replace it. */
  memory: MemoryConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const DEFAULT_RETRIEVAL_CONFIG: Readonly<RetrievalConfig> = Object.freeze({
  version: "retrieval-v4",
  weights: Object.freeze({ symbol: 0.3, lexical: 0.2, path: 0.15, dependency: 0.2, test: 0.1, proximity: 0.05 }),
  shortlistSize: 30,
  weakShortlistTotal: 0.1,
  expansion: Object.freeze({ seedCount: 5, maxNeighborsPerSeed: 4, maxExpanded: 10 }),
  memory: Object.freeze({ maxCandidates: 5, similarityMin: 0.3, maxRuns: 20, weight: 0.1 }),
});

function requirePositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RetrievalConfigError(field, `must be a positive integer: ${value}`);
}

/**
 * Merges overrides onto the defaults and validates the result. Weights must be finite and non-negative with at least
 * one positive; sizes must be positive integers; `expansion.maxExpanded` and `expansion.seedCount` cannot exceed
 * `shortlistSize`, since expansion only adds candidates to that list. Memory: `maxCandidates` a non-negative integer
 * (0 disables), `similarityMin` in (0, 1], `maxRuns` a positive integer, `weight` in [0, 1].
 */
export function resolveRetrievalConfig(overrides: DeepPartial<RetrievalConfig> = {}): RetrievalConfig {
  const base = DEFAULT_RETRIEVAL_CONFIG;
  const config: RetrievalConfig = {
    version: overrides.version ?? base.version,
    weights: { ...base.weights, ...overrides.weights },
    shortlistSize: overrides.shortlistSize ?? base.shortlistSize,
    weakShortlistTotal: overrides.weakShortlistTotal ?? base.weakShortlistTotal,
    expansion: { ...base.expansion, ...overrides.expansion },
    memory: { ...base.memory, ...overrides.memory },
  };
  if (!config.version.trim()) throw new RetrievalConfigError("version", "must not be empty");
  for (const [name, weight] of Object.entries(config.weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RetrievalConfigError(`weights.${name}`, `must be a finite, non-negative number: ${weight}`);
    }
  }
  if (!Object.values(config.weights).some((weight) => weight > 0)) {
    throw new RetrievalConfigError("weights", "at least one weight must be positive");
  }
  if (!Number.isFinite(config.weakShortlistTotal) || config.weakShortlistTotal < 0 || config.weakShortlistTotal > 1) {
    throw new RetrievalConfigError("weakShortlistTotal", `must be a number in [0, 1]: ${config.weakShortlistTotal}`);
  }
  requirePositiveInteger("shortlistSize", config.shortlistSize);
  for (const [name, value] of Object.entries(config.expansion)) requirePositiveInteger(`expansion.${name}`, value);
  for (const name of ["seedCount", "maxExpanded"] as const) {
    if (config.expansion[name] > config.shortlistSize) {
      throw new RetrievalConfigError(`expansion.${name}`, `must not exceed shortlistSize (${config.shortlistSize})`);
    }
  }
  const { maxCandidates, similarityMin, maxRuns, weight } = config.memory;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 0) {
    throw new RetrievalConfigError("memory.maxCandidates", `must be a non-negative integer: ${maxCandidates}`);
  }
  if (!Number.isFinite(similarityMin) || similarityMin <= 0 || similarityMin > 1) {
    throw new RetrievalConfigError("memory.similarityMin", `must be a number in (0, 1]: ${similarityMin}`);
  }
  requirePositiveInteger("memory.maxRuns", maxRuns);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new RetrievalConfigError("memory.weight", `must be a finite number in [0, 1]: ${weight}`);
  }
  return config;
}
