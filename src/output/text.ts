import { mergeRegions, type Region } from "../context/regions.ts";
import type { ScopeResult, SelectedChunk } from "../types.ts";

export const byLocation = (a: SelectedChunk, b: SelectedChunk): number =>
  a.chunk.file.localeCompare(b.chunk.file) ||
  a.chunk.startLine - b.chunk.startLine ||
  a.chunk.id.localeCompare(b.chunk.id);

export function labelOf({ relevance, score, supportFor }: SelectedChunk): string {
  // A pull-in was not judged, so it carries no score; printing one would misstate Jev's decision.
  return relevance === undefined && supportFor
    ? "supporting declaration"
    : `${relevance === undefined ? "score" : "relevance"} ${(relevance ?? score).toFixed(2)}`;
}

function renderRegion(region: Region): string {
  const { chunks } = region;
  const names = [...new Set(chunks.flatMap((item) => (item.chunk.name ? [item.chunk.name] : [])))].join(", ");
  const symbol = names ? ` ${names}` : "";
  const label =
    chunks.length === 1
      ? labelOf(chunks[0]!)
      : chunks.map((item) => (item.chunk.name ? `${item.chunk.name} ${labelOf(item)}` : labelOf(item))).join("; ");
  return `== ${region.file}:${region.startLine}-${region.endLine}${symbol} (${label}) ==\n${region.content}\n`;
}

/**
 * Plain-text artifact: a task header, then each region under its exact `path:start-end` location. Chunks that touch or
 * overlap are merged first, so a line is never printed (or charged) twice.
 */
export function renderText(task: string, chunks: readonly SelectedChunk[]): string {
  return [`Scope context for: ${task}\n`, ...mergeRegions(chunks).map(renderRegion)].join("\n");
}

/** The text form of a result. Kept separate from `renderText` so selection can measure candidate sets. */
export const renderResult = (result: ScopeResult): string => renderText(result.task, result.chunks);
