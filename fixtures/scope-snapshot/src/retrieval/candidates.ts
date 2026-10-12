import type { CodeChunk } from "../types.ts";
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from "./config.ts";
import { generateCandidates } from "./generate.ts";
import type { Candidate } from "./rank.ts";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareChunks(a: CodeChunk, b: CodeChunk): number {
  return compareStrings(a.file, b.file) || a.startLine - b.startLine || compareStrings(a.id, b.id);
}

export interface CandidateSelection {
  /** What the Jev adapter receives, best first (see {@link selectCandidates}). */
  candidates: CodeChunk[];
  /** How retrieval ranked the candidates it found, by chunk id: signals, total and origin. */
  ranking: ReadonlyMap<string, Candidate>;
  /** Set when the shortlist is weak or empty, so the task is unlikely to be served well. */
  warning?: string;
}

/**
 * The shortlist for a task: the best `shortlistSize` of the scored, graph-expanded, deduplicated candidates, in rank
 * order. A repository with no more chunks than that has nothing to filter, so all of its chunks are sent, the ranked
 * ones first and the rest in path order.
 */
export function selectCandidates(
  task: string,
  chunks: readonly CodeChunk[],
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): CandidateSelection {
  const ranked = generateCandidates(task, chunks, config);
  const ranking = new Map(ranked.map((candidate) => [candidate.chunkId, candidate]));
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const shortlisted = ranked.slice(0, config.shortlistSize).map((candidate) => byId.get(candidate.chunkId)!);
  if (chunks.length <= config.shortlistSize) {
    const rest = chunks.filter((chunk) => !ranking.has(chunk.id)).sort(compareChunks);
    return { candidates: [...shortlisted, ...rest], ranking };
  }
  const best = ranked[0]?.total ?? 0;
  const weak = best < config.weakShortlistTotal;
  return {
    candidates: shortlisted,
    ranking,
    ...(weak && {
      warning:
        shortlisted.length === 0
          ? "No chunk matched the task, so there is nothing to judge; try naming files, symbols or behavior from the code"
          : `Weak shortlist: the best of ${shortlisted.length} candidates scores ${best.toFixed(2)}, below ` +
            `${config.weakShortlistTotal}; the task shares little with the code, so the result may be poor`,
    }),
  };
}
