import { MAX_CANDIDATES } from "../config.ts";
import type { CodeChunk } from "../types.ts";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareChunks(a: CodeChunk, b: CodeChunk): number {
  return compareStrings(a.file, b.file) || a.startLine - b.startLine || compareStrings(a.id, b.id);
}

/** Words too common in task text to say anything about relevance. */
const STOP_WORDS = new Set(["the", "and", "for", "from", "with", "into", "that", "this", "its", "each", "instead"]);

/** Lowercase words of identifiers and prose: splits on non-alphanumerics, camelCase and digit boundaries. */
function tokenize(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return new Set(
    words
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/** Task words found in the path or name count double (they name the code); words found in the content count once. */
function overlapScore(taskWords: Set<string>, chunk: CodeChunk): number {
  const named = tokenize(`${chunk.file} ${chunk.name ?? ""}`);
  const body = tokenize(chunk.content);
  let score = 0;
  for (const word of taskWords) score += (named.has(word) ? 2 : 0) + (body.has(word) ? 1 : 0);
  return score;
}

export interface CandidateSelection {
  /** In deterministic order (path, start line, ID). */
  candidates: CodeChunk[];
  /** Set when the eligible chunks exceeded the cap and were pre-filtered, so retrieval is provisional. */
  warning?: string;
}

/**
 * Provisional candidate list until Milestone 3 retrieval replaces it. Up to the cap, every eligible chunk is a candidate.
 * Beyond it, the chunks with the highest lexical overlap with the task are kept (ties by path, start line, ID). The Jev
 * adapter only ever receives `candidates`.
 */
export function selectCandidates(
  task: string,
  chunks: readonly CodeChunk[],
  options: { max?: number } = {},
): CandidateSelection {
  const max = options.max ?? MAX_CANDIDATES;
  const ordered = [...chunks].sort(compareChunks);
  if (ordered.length <= max) return { candidates: ordered };
  const taskWords = tokenize(task);
  const kept = ordered
    .map((chunk) => ({ chunk, score: overlapScore(taskWords, chunk) }))
    // Array.sort is stable, so equal scores keep the deterministic order established above.
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ chunk }) => chunk)
    .sort(compareChunks);
  return {
    candidates: kept,
    warning:
      `${ordered.length} eligible chunks exceed the candidate cap of ${max}; candidates were pre-filtered by ` +
      `lexical overlap (retrieval is provisional until Milestone 3)`,
  };
}
