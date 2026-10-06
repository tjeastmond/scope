import { mergeRegions, type Region } from "../context/regions.ts";
import type { ScopeResult, SelectedChunk } from "../types.ts";
import { belowThresholdLine, leftOutLines, sanitizeInline, scoreLabel, summaryLines, unmetLines } from "./report.ts";

export const byLocation = (a: SelectedChunk, b: SelectedChunk): number =>
  a.chunk.file.localeCompare(b.chunk.file) ||
  a.chunk.startLine - b.chunk.startLine ||
  a.chunk.id.localeCompare(b.chunk.id);

export function labelOf({ relevance, score, supportFor }: SelectedChunk): string {
  // A pull-in was not judged, so it carries no score; printing one would misstate Jev's decision.
  return relevance === undefined && supportFor ? "supporting declaration" : scoreLabel(relevance, score);
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
 * Plain-text artifact: a task header and summary, then each region under its exact `path:start-end` location (chunks
 * that touch or overlap are merged first, so a line is never printed or charged twice), then what was left out and
 * which supporting declarations are missing. Empty sections are omitted.
 */
export function renderResult(result: ScopeResult): string {
  const section = (title: string, lines: string[]) =>
    lines.length === 0 ? [] : [`-- ${title} --\n${lines.join("\n")}\n`];
  const below = belowThresholdLine(result);
  return [
    `Scope context for: ${result.task}\n`,
    `${summaryLines(result, sanitizeInline).join("\n")}\n`,
    ...mergeRegions(result.chunks).map(renderRegion),
    ...section("Left out (over budget)", leftOutLines(result, sanitizeInline)),
    ...(below === undefined ? [] : [`${below}\n`]),
    ...section("Unmet coherence", unmetLines(result, sanitizeInline)),
  ].join("\n");
}
