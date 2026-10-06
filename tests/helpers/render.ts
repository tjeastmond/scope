import { mergeRegions, toScopeRegion } from "../../src/context/regions.ts";
import { byLocation, renderResult } from "../../src/output/text.ts";
import type { SelectedChunk } from "../../src/types.ts";

/** The text artifact holding exactly these chunks (no skips or warnings). */
export function renderText(task: string, chunks: readonly SelectedChunk[]): string {
  const sorted = [...chunks].sort(byLocation);
  return renderResult({
    schemaVersion: 2,
    mode: "jev",
    task,
    chunks: sorted,
    regions: mergeRegions(sorted).map(toScopeRegion),
    warnings: [],
    skipped: [],
  });
}
