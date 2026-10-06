// Candidate generation: task terms, indexes and graph over the chunks, lexical scoring, graph expansion and signals,
// then removal of duplicates. Pure and deterministic: no randomness, clock or file-system order enters the result, and
// the order of `chunks` does not matter.

import { buildGraph } from "../graph/graph.ts";
import type { CodeChunk } from "../types.ts";
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from "./config.ts";
import { buildIndexes, type RetrievalIndexes } from "./indexes.ts";
import { rankCandidates, type Candidate } from "./rank.ts";
import { scoreChunks } from "./score.ts";
import { extractTaskTerms } from "./terms.ts";

/**
 * Drops a candidate that repeats an earlier one's chunk id or its exact range in the same file (the first, best-ranked,
 * is kept). Chunks within a file never overlap except a container header and its members, which cover different
 * lines and so are all kept (docs/chunk-model.md, "Containers").
 */
export function dedupeCandidates(ranked: readonly Candidate[], indexes: RetrievalIndexes): Candidate[] {
  const ids = new Set<string>();
  const ranges = new Set<string>();
  const kept: Candidate[] = [];
  for (const candidate of ranked) {
    const chunk = indexes.byId.get(candidate.chunkId);
    const range = chunk && `${chunk.file}:${chunk.startLine}-${chunk.endLine}`;
    if (ids.has(candidate.chunkId) || (range !== undefined && ranges.has(range))) continue;
    ids.add(candidate.chunkId);
    if (range !== undefined) ranges.add(range);
    kept.push(candidate);
  }
  return kept;
}

/**
 * Every candidate for the task, best first (total score descending, then path, start line and id), deduplicated and not
 * truncated; the shortlist cap is applied by the caller.
 */
export function generateCandidates(
  task: string,
  chunks: readonly CodeChunk[],
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): Candidate[] {
  const indexes = buildIndexes(chunks);
  const lexical = scoreChunks(extractTaskTerms(task), indexes, config.weights);
  return dedupeCandidates(rankCandidates(lexical, buildGraph(chunks), indexes, config), indexes);
}
