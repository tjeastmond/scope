// One-hop graph expansion: the strongest scored chunks bring in their graph neighbours as extra candidates. Pure and
// deterministic; the neighbours are candidates for Jev to judge, never automatic inclusions.

import type { NeighborConfidence, RepositoryGraph } from "../graph/types.ts";
import type { RetrievalConfig } from "./config.ts";
import type { ChunkScore } from "./score.ts";

export interface Expansion {
  chunkId: string;
  origin: `expanded-from:${string}`;
  /** The seed that brought it in: the highest-ranked seed that reaches it. */
  seedId: string;
  confidence: NeighborConfidence;
  /** Evidence of the edge between the seed and this chunk. */
  evidence: string;
}

const CONFIDENCE_RANK: Record<NeighborConfidence, number> = { exact: 0, heuristic: 1 };

/**
 * Expands the first `seedCount` positively scored entries of `scores` (already ranked) by one hop. Each seed takes at
 * most `maxNeighborsPerSeed` neighbours, exact edges before heuristic ones and then in the graph's own order; at most
 * `maxExpanded` are returned in total. Chunks that are seeds or already scored are not new candidates, a chunk is
 * expanded once (attributed to the first seed reaching it), and expanded chunks are never expanded again.
 */
export function expandNeighbors(
  scores: readonly ChunkScore[],
  graph: RepositoryGraph,
  config: RetrievalConfig["expansion"],
): Expansion[] {
  const seeds = scores.slice(0, config.seedCount).filter((score) => score.total > 0);
  const visited = new Set(scores.map((score) => score.chunkId));
  const expansions: Expansion[] = [];
  for (const seed of seeds) {
    if (expansions.length >= config.maxExpanded) break;
    const neighbors = graph
      .neighbors(seed.chunkId)
      .map((neighbor, index) => ({ neighbor, index }))
      .sort(
        (a, b) => CONFIDENCE_RANK[a.neighbor.confidence] - CONFIDENCE_RANK[b.neighbor.confidence] || a.index - b.index,
      );
    let taken = 0;
    for (const { neighbor } of neighbors) {
      if (taken >= config.maxNeighborsPerSeed || expansions.length >= config.maxExpanded) break;
      if (visited.has(neighbor.chunkId)) continue;
      visited.add(neighbor.chunkId);
      taken++;
      expansions.push({
        chunkId: neighbor.chunkId,
        origin: `expanded-from:${seed.chunkId}`,
        seedId: seed.chunkId,
        confidence: neighbor.confidence,
        evidence: neighbor.evidence,
      });
    }
  }
  return expansions;
}
