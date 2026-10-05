import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, ChunkKind, CodeChunk, Language, TokenEstimator } from "../types.ts";

/** A region an extractor found, as a 1-based inclusive line range. */
export interface Region {
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  name?: string | undefined;
}

/**
 * Turns regions into chunks: `content` is the exact source lines of each range (split on `\n` only), identical
 * regions (for example two `<nav></nav>` on one line) collapse to one so chunk ids stay unique, and `broken` adds the
 * syntax-error warning, which counts the extracted `unit`s.
 */
export function assembleChunks(
  file: string,
  source: string,
  language: Language,
  regions: readonly Region[],
  broken: boolean,
  estimator: TokenEstimator,
  unit = "chunks",
): AnalysisResult {
  const lines = source.split("\n");
  const chunks = regions.map(({ startLine, endLine, kind, name }): CodeChunk => {
    const content = lines.slice(startLine - 1, endLine).join("\n");
    return {
      id: makeChunkId({ file, startLine, endLine, kind, name }),
      file,
      language,
      kind,
      ...(name === undefined ? {} : { name }),
      startLine,
      endLine,
      content,
      references: [],
      estimatedTokens: estimator.count(content),
    };
  });
  const unique = [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
  const warnings = broken
    ? [`${file}: syntax errors; extracted ${unique.length} ${unit} from the parseable regions`]
    : [];
  return { chunks: unique, warnings };
}

/** Collapses runs of whitespace to single spaces, for names taken from source text. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
