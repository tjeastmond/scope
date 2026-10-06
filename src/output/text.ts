import type { ScopeResult, SelectedChunk } from "../types.ts";

export const byLocation = (a: SelectedChunk, b: SelectedChunk): number =>
  a.chunk.file.localeCompare(b.chunk.file) ||
  a.chunk.startLine - b.chunk.startLine ||
  a.chunk.id.localeCompare(b.chunk.id);

function renderChunk({ chunk, relevance, score, supportFor }: SelectedChunk): string {
  const symbol = chunk.name ? ` ${chunk.name}` : "";
  // A pull-in was not judged, so it carries no score; printing one would misstate Jev's decision.
  const label =
    relevance === undefined && supportFor
      ? "supporting declaration"
      : `${relevance === undefined ? "score" : "relevance"} ${(relevance ?? score).toFixed(2)}`;
  return `== ${chunk.file}:${chunk.startLine}-${chunk.endLine}${symbol} (${label}) ==\n${chunk.content}\n`;
}

/** Plain-text artifact: a task header, then each chunk under its exact `path:start-end` location. */
export function renderText(task: string, chunks: readonly SelectedChunk[]): string {
  return [`Scope context for: ${task}\n`, ...[...chunks].sort(byLocation).map(renderChunk)].join("\n");
}

/** The text form of a result. Kept separate from `renderText` so selection can measure candidate sets. */
export const renderResult = (result: ScopeResult): string => renderText(result.task, result.chunks);
