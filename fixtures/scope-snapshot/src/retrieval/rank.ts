// Candidate ranking: the lexical scores plus the graph signals. The strongest lexical matches are seeds; their one-hop
// neighbours and linked test chunks join as expanded candidates. Every candidate carries all six signals separately,
// and its origin says whether it matched directly or came in through a seed.

import type { NeighborConfidence, RepositoryGraph } from "../graph/types.ts";
import type { RetrievalConfig } from "./config.ts";
import { expandNeighbors, relatedTestFiles, selectSeeds } from "./expand.ts";
import type { RetrievalIndexes } from "./indexes.ts";
import { compareScores, weighSignals, type ChunkScore, type Signal } from "./score.ts";

export interface Candidate extends ChunkScore {
  /** `direct` when lexical signals matched it; otherwise the seed that brought it in. */
  origin: "direct" | `expanded-from:${string}`;
}

/** Dependency signal by edge confidence: an exact edge is full strength, a heuristic one a bit weaker. */
const DEPENDENCY_SIGNAL: Record<NeighborConfidence, number> = { exact: 1, heuristic: 0.6 };
/** Proximity signal: same directory as the best seed, or only the same top-level directory. */
const SAME_DIRECTORY = 1;
const SAME_TOP_LEVEL = 0.5;

const directoryOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/")));
const topLevelOf = (file: string): string => file.split("/")[0] ?? "";

/**
 * Ranks the lexical candidates together with their graph expansions, sorted by total descending, then file, start line
 * and id. Not truncated and not deduplicated.
 *
 * Signals, per non-seed candidate (seeds have 0 for all three, so a seed's own match is not counted twice):
 * - dependency: the best confidence of a graph edge to any seed (1.0 exact, 0.6 heuristic), whether the chunk matched
 *   directly or was expanded; 0 without an edge.
 * - test: 1.0 for a chunk in a test file linked to a seed's file, or in a source file linked to a test seed.
 * - proximity: relative to the best-ranked seed's file, 1.0 for the same directory, 0.5 for the same first path
 *   segment but another directory, 0 otherwise.
 */
export function rankCandidates(
  lexical: readonly ChunkScore[],
  graph: RepositoryGraph,
  indexes: RetrievalIndexes,
  config: RetrievalConfig,
): Candidate[] {
  const seeds = selectSeeds(lexical, config.expansion);
  const seedIds = new Set(seeds.map((seed) => seed.chunkId));
  const dependency = new Map<string, number>();
  const testFiles = new Set<string>();
  for (const seed of seeds) {
    for (const neighbor of graph.neighbors(seed.chunkId)) {
      dependency.set(
        neighbor.chunkId,
        Math.max(dependency.get(neighbor.chunkId) ?? 0, DEPENDENCY_SIGNAL[neighbor.confidence]),
      );
    }
    for (const file of relatedTestFiles(seed.chunkId, graph, indexes)) testFiles.add(file);
  }
  const bestFile = seeds[0] && indexes.byId.get(seeds[0].chunkId)?.file;

  const proximity = (file: string): number => {
    if (bestFile === undefined) return 0;
    if (directoryOf(file) === directoryOf(bestFile)) return SAME_DIRECTORY;
    return topLevelOf(file) === topLevelOf(bestFile) ? SAME_TOP_LEVEL : 0;
  };
  const withGraphSignals = (score: ChunkScore, origin: Candidate["origin"]): Candidate => {
    if (seedIds.has(score.chunkId)) return { ...score, origin };
    const file = indexes.byId.get(score.chunkId)?.file ?? "";
    const signals: Record<Signal, number> = {
      ...score.signals,
      dependency: dependency.get(score.chunkId) ?? 0,
      test: testFiles.has(file) ? 1 : 0,
      proximity: proximity(file),
    };
    return { ...weighSignals(score.chunkId, signals, config.weights), origin };
  };

  const zero: Record<Signal, number> = { symbol: 0, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 };
  const candidates = [
    ...lexical.map((score) => withGraphSignals(score, "direct")),
    ...expandNeighbors(lexical, graph, config.expansion, indexes).map((e) =>
      withGraphSignals(weighSignals(e.chunkId, zero, config.weights), e.origin),
    ),
  ];
  return candidates.sort(compareScores(indexes));
}
