// One-hop graph expansion: the strongest scored chunks bring in their graph neighbours, and the chunks of the test
// files linked to their file, as extra candidates. Pure and deterministic; they are candidates for Jev to judge,
// never automatic inclusions.

import type { NeighborConfidence, RepositoryGraph } from "../graph/types.ts";
import type { RetrievalConfig } from "./config.ts";
import type { RetrievalIndexes } from "./indexes.ts";
import type { ChunkScore } from "./score.ts";

export interface Expansion {
  chunkId: string;
  origin: `expanded-from:${string}`;
  /** The seed that brought it in: the highest-ranked seed that reaches it. */
  seedId: string;
  /** `dependency`: a graph neighbour of the seed. `test`: a chunk of a test file linked to the seed's file. */
  relation: "dependency" | "test";
  confidence: NeighborConfidence;
  /** Evidence of the edge between the seed and this chunk. */
  evidence: string;
}

/** The first `seedCount` positively scored entries of `scores` (already ranked). */
export function selectSeeds(scores: readonly ChunkScore[], config: RetrievalConfig["expansion"]): ChunkScore[] {
  return scores.slice(0, config.seedCount).filter((score) => score.total > 0);
}

/**
 * Files linked to the seed's file by test naming: the tests of a source file, or the sources of a test file. Empty
 * unless `indexes` is given.
 */
export function relatedTestFiles(
  seedId: string,
  graph: RepositoryGraph,
  indexes: RetrievalIndexes | undefined,
): string[] {
  const file = indexes?.byId.get(seedId)?.file;
  return file === undefined ? [] : [...graph.testsFor(file), ...graph.sourcesFor(file)];
}

/**
 * Expands the seeds by one hop. Each seed takes at most `maxNeighborsPerSeed` candidates, first its graph neighbours
 * in the graph's own order (exact edges before heuristic ones), then, when `indexes` is given, the chunks of its
 * linked test files (files in sorted order, chunks in start-line order); at most `maxExpanded` are returned in
 * total. Chunks that are seeds or already scored are not new candidates, a chunk is expanded once (attributed to the
 * first seed reaching it), and expanded chunks are never expanded again.
 */
export function expandNeighbors(
  scores: readonly ChunkScore[],
  graph: RepositoryGraph,
  config: RetrievalConfig["expansion"],
  indexes?: RetrievalIndexes,
): Expansion[] {
  const visited = new Set(scores.map((score) => score.chunkId));
  const expansions: Expansion[] = [];
  for (const seed of selectSeeds(scores, config)) {
    if (expansions.length >= config.maxExpanded) break;
    let taken = 0;
    const full = () => taken >= config.maxNeighborsPerSeed || expansions.length >= config.maxExpanded;
    const add = (
      chunkId: string,
      relation: Expansion["relation"],
      confidence: NeighborConfidence,
      evidence: string,
    ) => {
      if (visited.has(chunkId)) return;
      visited.add(chunkId);
      taken++;
      expansions.push({
        chunkId,
        origin: `expanded-from:${seed.chunkId}`,
        seedId: seed.chunkId,
        relation,
        confidence,
        evidence,
      });
    };
    for (const neighbor of graph.neighbors(seed.chunkId)) {
      if (full()) break;
      add(neighbor.chunkId, "dependency", neighbor.confidence, neighbor.evidence);
    }
    for (const file of relatedTestFiles(seed.chunkId, graph, indexes)) {
      for (const chunkId of indexes?.paths.chunksByFile.get(file) ?? []) {
        if (full()) break;
        add(chunkId, "test", "heuristic", `file linked to ${indexes?.byId.get(seed.chunkId)?.file} by test naming`);
      }
    }
  }
  return expansions;
}
