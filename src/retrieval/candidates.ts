import { MAX_CANDIDATES } from "../config.ts";
import type { CodeChunk } from "../types.ts";

export class CandidateLimitError extends Error {
  constructor(
    readonly eligible: number,
    readonly max: number,
  ) {
    super(
      `${eligible} chunks are eligible but at most ${max} can be judged; Milestone 1 does not truncate. ` +
        `Use a smaller repository (candidate retrieval arrives in Milestone 3).`,
    );
    this.name = "CandidateLimitError";
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareChunks(a: CodeChunk, b: CodeChunk): number {
  return compareStrings(a.file, b.file) || a.startLine - b.startLine || compareStrings(a.id, b.id);
}

/**
 * Milestone 1 candidate list: every eligible chunk in deterministic order (path, start line, ID). This is the seam
 * Milestone 3 replaces with real retrieval; the Jev adapter only ever receives this function's output.
 */
export function selectCandidates(chunks: readonly CodeChunk[], options: { max?: number } = {}): CodeChunk[] {
  const max = options.max ?? MAX_CANDIDATES;
  if (chunks.length > max) throw new CandidateLimitError(chunks.length, max);
  return [...chunks].sort(compareChunks);
}
