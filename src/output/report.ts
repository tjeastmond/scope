import type { ScopeResult, SkippedChunk } from "../types.ts";

/**
 * Report facts shared by the text and Markdown formats, so the two never drift apart. Each helper returns plain lines
 * and takes a `quote` function that wraps text taken from the repository (paths, symbol names, ids): a sanitizer for
 * text, a code span for Markdown.
 */
export type Quote = (text: string) => string;

/** Line breaks and control characters would end a single-line construct, so they become visible placeholders. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu;
export const sanitizeInline = (text: string): string => text.replace(CONTROL, "\u{FFFD}");

/** `relevance 0.87` (Jev's judgment) or `score 0.40` (ranking signal when no judgment exists). */
export const scoreLabel = (relevance: number | undefined, score: number): string =>
  `${relevance === undefined ? "score" : "relevance"} ${(relevance ?? score).toFixed(2)}`;

/** Mode, budget, artifact size, region count and retrieval version; the same facts in every human-readable format. */
export function summaryLines(result: ScopeResult, quote: Quote): string[] {
  const { mode, budget, estimatedTokens, estimator, characters, lines, regions, retrievalConfigVersion } = result;
  return [
    `Mode: ${mode}`,
    `Budget: ${budget} estimated tokens`,
    `Artifact: ${estimatedTokens} estimated tokens (estimator ${quote(estimator)}), ${characters} characters, ${lines} lines`,
    `Regions: ${regions.length}`,
    ...(retrievalConfigVersion === undefined ? [] : [`Retrieval config: ${quote(retrievalConfigVersion)}`]),
  ];
}

const location = (entry: { file: string; startLine: number; endLine: number; name?: string }, quote: Quote): string =>
  quote(`${entry.file}:${entry.startLine}-${entry.endLine}${entry.name ? ` ${entry.name}` : ""}`);

const overBudget = (result: ScopeResult): SkippedChunk[] =>
  result.skipped.filter((entry) => entry.reason === "over-budget");

/** Most over-budget skips listed in text and Markdown; the rest are counted, so the list cannot starve the budget. */
export const MAX_LEFT_OUT_LISTED = 5;

/**
 * One line per relevant chunk that did not fit, most relevant first (ties by location), at most
 * `MAX_LEFT_OUT_LISTED`, then a count of the rest. Empty when nothing was left out for budget reasons. JSON lists all.
 */
export function leftOutLines(result: ScopeResult, quote: Quote): string[] {
  const ranked = overBudget(result).sort(
    (a, b) =>
      (b.relevance ?? b.score) - (a.relevance ?? a.score) ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.chunkId.localeCompare(b.chunkId),
  );
  const lines = ranked
    .slice(0, MAX_LEFT_OUT_LISTED)
    .map(
      (entry) =>
        `${location(entry, quote)} (${scoreLabel(entry.relevance, entry.score)}): ${entry.estimatedTokens} estimated tokens` +
        (entry.minimumBudget === undefined ? "" : `, fits alone in a budget of ${entry.minimumBudget}`),
    );
  const more = ranked.length - lines.length;
  return more > 0 ? [...lines, `and ${more} more left out; --format json lists every one.`] : lines;
}

/** Below-threshold skips are expected filtering, so they are counted, not listed; JSON lists every one. */
export function belowThresholdLine(result: ScopeResult): string | undefined {
  const count = result.skipped.filter((entry) => entry.reason === "below-threshold").length;
  return count === 0 ? undefined : `${count} candidate(s) scored below the relevance minimum and are not listed.`;
}

/** One line per unmet requirement, with chunk ids resolved to `path:start-end name` where the result knows them. */
export function unmetLines(result: ScopeResult, quote: Quote): string[] {
  const known = new Map<string, string>();
  for (const entry of result.skipped) known.set(entry.chunkId, location(entry, quote));
  for (const { chunk } of result.chunks) known.set(chunk.id, location(chunk, quote));
  const label = (id: string) => known.get(id) ?? `chunk ${quote(id)}`;
  return result.unmetCoherence.map(
    (entry) =>
      `${label(entry.chunkId)} needs ${label(entry.requiredId)}: ${
        entry.reason === "too-large" ? "too large to include as a supporting declaration" : "did not fit the budget"
      } (${entry.reason})`,
  );
}
