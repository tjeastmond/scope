// EXPERIMENTAL (issue #166): merges a path prior (a score in [0, 1] per file, from Jev ranking file and directory
// names) into the ranked candidates. Off unless the caller passes a prior; without one, retrieval is untouched.
//
// Scale: every existing total is a sum of weights times signals in [0, 1], and the six weights sum to 1. The prior
// acts as a seventh signal in the same units: a candidate's total gains `weight * prior(file)`, so with the default
// weight of 0.2 a file Jev ranks best adds as much as a perfect lexical (source-text) match, and a prior of 0.5 adds
// as much as a half-strength path signal. Chunks in test files get the same test demotion as every other signal
// unless the task mentions tests.

import { isTestFile } from "../graph/tests.ts";
import type { CodeChunk } from "../types.ts";
import type { RetrievalIndexes } from "./indexes.ts";
import type { Candidate } from "./rank.ts";
import { compareScores, weighSignals } from "./score.ts";

export interface PathPriorConfig {
  /** Added to a candidate's total per unit of prior, in the units of the existing totals (default 0.2). */
  weight: number;
  /** New candidates added from files that had none (default 10). */
  maxAdded: number;
  /** A file needs at least this prior, in [0, 1], to have a candidate added for it (default 0.5). */
  minFilePrior: number;
}

export const DEFAULT_PATH_PRIOR_CONFIG: Readonly<PathPriorConfig> = Object.freeze({
  weight: 0.2,
  maxAdded: 10,
  minFilePrior: 0.5,
});

/** What a path prior changed in the shortlist handed to Jev. */
export interface PathPriorContribution {
  /** Shortlisted candidates whose total was raised by the prior. */
  boosted: number;
  /** Files whose chunk the prior added to the shortlist (origin `path-prior`), best first. */
  added: string[];
}

export interface PathPriorInput {
  /** Prior per repository-relative file in [0, 1]; a missing file counts as 0. */
  scores: ReadonlyMap<string, number>;
  config?: Partial<PathPriorConfig>;
}

export function resolvePathPriorConfig(overrides: Partial<PathPriorConfig> = {}): PathPriorConfig {
  const config = { ...DEFAULT_PATH_PRIOR_CONFIG, ...overrides };
  if (!Number.isFinite(config.weight) || config.weight < 0) throw new Error("pathPrior weight must be non-negative.");
  if (!Number.isInteger(config.maxAdded) || config.maxAdded < 0)
    throw new Error("pathPrior maxAdded must be a non-negative integer.");
  if (!Number.isFinite(config.minFilePrior) || config.minFilePrior < 0 || config.minFilePrior > 1)
    throw new Error("pathPrior minFilePrior must be a number in [0, 1].");
  return config;
}

const ZERO = { symbol: 0, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 };

const prior = (scores: ReadonlyMap<string, number>, file: string): number => {
  const value = scores.get(file);
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
};

/** The chunk to stand for a file with no candidate: the first named, non-container chunk, else the first chunk. */
function representative(chunks: readonly CodeChunk[]): CodeChunk | undefined {
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.find((c) => c.name !== undefined && c.kind !== "class") ?? sorted[0];
}

/**
 * Raises the total of every ranked candidate by `weight * prior(file)` and adds up to `maxAdded` candidates, one chunk
 * each, for non-test files with prior at least `minFilePrior` and no candidate yet (total `weight * prior`, origin
 * `path-prior`). Returns the re-sorted list; the input is not changed.
 */
export function applyPathPrior(
  ranked: readonly Candidate[],
  indexes: RetrievalIndexes,
  { scores, config: overrides }: PathPriorInput,
  testDemotion: number,
): Candidate[] {
  const config = resolvePathPriorConfig(overrides);
  const factorOf = (file: string) => (isTestFile(file) ? testDemotion : 1);
  const have = new Set<string>();
  const out: Candidate[] = ranked.map((candidate) => {
    const file = indexes.byId.get(candidate.chunkId)?.file;
    if (file === undefined) return candidate;
    have.add(file);
    const boost = config.weight * prior(scores, file) * factorOf(file);
    return boost > 0 ? { ...candidate, total: candidate.total + boost, pathPrior: boost } : candidate;
  });

  const byFile = new Map<string, CodeChunk[]>();
  for (const chunk of indexes.chunks) {
    if (have.has(chunk.file) || isTestFile(chunk.file)) continue;
    byFile.set(chunk.file, [...(byFile.get(chunk.file) ?? []), chunk]);
  }
  const eligible = [...byFile.keys()]
    .filter((file) => prior(scores, file) >= config.minFilePrior && prior(scores, file) > 0)
    .sort((a, b) => prior(scores, b) - prior(scores, a) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, config.maxAdded);
  for (const file of eligible) {
    const chunk = representative(byFile.get(file)!)!;
    const boost = config.weight * prior(scores, file);
    out.push({ ...weighSignals(chunk.id, ZERO, {}), total: boost, pathPrior: boost, origin: "path-prior" });
  }
  return out.sort(compareScores(indexes));
}
