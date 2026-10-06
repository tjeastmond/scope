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

export const location = (
  entry: { file: string; startLine: number; endLine: number; name?: string },
  quote: Quote,
): string => quote(`${entry.file}:${entry.startLine}-${entry.endLine}${entry.name ? ` ${entry.name}` : ""}`);

const skippedFor = (result: ScopeResult, reason: SkippedChunk["reason"]): SkippedChunk[] =>
  result.skipped.filter((entry) => entry.reason === reason);

/** Most relevant first, ties by location. */
const mostRelevantFirst = (entries: SkippedChunk[]): SkippedChunk[] =>
  entries.sort(
    (a, b) =>
      (b.relevance ?? b.score) - (a.relevance ?? a.score) ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.chunkId.localeCompare(b.chunkId),
  );

/** Most over-budget skips listed in text and Markdown; the rest are counted, so the list cannot starve the budget. */
export const MAX_LEFT_OUT_LISTED = 5;

/**
 * One line per relevant chunk that did not fit, most relevant first (ties by location), at most
 * `MAX_LEFT_OUT_LISTED`, then a count of the rest. Empty when nothing was left out for budget reasons. JSON lists all.
 */
export function leftOutLines(result: ScopeResult, quote: Quote): string[] {
  const ranked = mostRelevantFirst(skippedFor(result, "over-budget"));
  const lines = ranked
    .slice(0, MAX_LEFT_OUT_LISTED)
    .map(
      (entry) =>
        `${location(entry, quote)} (${scoreLabel(entry.relevance, entry.score)}): ${entry.estimatedTokens} estimated tokens` +
        (entry.minimumBudget === undefined ? "" : `, needs a budget of at least ${entry.minimumBudget}`),
    );
  const more = ranked.length - lines.length;
  return more > 0 ? [...lines, `and ${more} more left out; --format json lists every one.`] : lines;
}

/**
 * Below-threshold skips are expected filtering, so by default they are only counted. Under `--explain` the most
 * relevant ones are listed too, capped like the over-budget list; JSON lists every one.
 */
export function belowThresholdLines(result: ScopeResult, quote: Quote): string[] {
  const ranked = mostRelevantFirst(skippedFor(result, "below-threshold"));
  if (ranked.length === 0) return [];
  if (!result.explain) return [`${ranked.length} candidate(s) scored below the relevance minimum and are not listed.`];
  const lines = ranked
    .slice(0, MAX_LEFT_OUT_LISTED)
    .map(
      (entry) => `${location(entry, quote)} (${scoreLabel(entry.relevance, entry.score)}): below the relevance minimum`,
    );
  const more = ranked.length - lines.length;
  return more > 0 ? [...lines, `and ${more} more below the relevance minimum; --format json lists every one.`] : lines;
}

/** Chunk ids resolved to `path:start-end name` where the result knows them, else `chunk <id>`. */
function labeler(result: ScopeResult, quote: Quote): (id: string) => string {
  const known = new Map<string, string>();
  for (const entry of result.skipped) known.set(entry.chunkId, location(entry, quote));
  for (const { chunk } of result.chunks) known.set(chunk.id, location(chunk, quote));
  return (id) => known.get(id) ?? `chunk ${quote(id)}`;
}

/** Signal names are fixed by the retrieval config; sorted so the line is deterministic. */
export const signalPairs = (signals: Record<string, number>): [string, number][] =>
  Object.entries(signals).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export interface ExplainBlock {
  title: string;
  lines: string[];
}

/** The `--explain` evidence for every selected chunk, in the order of `result.chunks`; shared by text and Markdown. */
export function explainBlocks(result: ScopeResult, quote: Quote): ExplainBlock[] {
  const label = labeler(result, quote);
  return result.chunks.map(({ chunk, signals, origin, relevance, score, reason, supportFor }) => {
    const found = signalPairs(signals).map(([name, value]) => `${name} ${value.toFixed(2)}`);
    let source = "not recorded";
    if (supportFor) source = `supporting declaration for ${supportFor.map(label).join(", ")}`;
    else if (origin === "direct") source = "direct (dependency distance 0)";
    else if (origin?.startsWith("expanded-from:"))
      source = `expanded from ${label(origin.slice("expanded-from:".length))} (dependency distance 1)`;
    return {
      title: location(chunk, quote),
      lines: [
        `Signals: ${found.length === 0 ? "none" : found.join(", ")}`,
        `Jev relevance: ${relevance === undefined ? "not judged" : relevance.toFixed(2)}`,
        `Score: ${score.toFixed(2)}`,
        `Token cost: ${chunk.estimatedTokens} estimated tokens`,
        `Origin: ${source}`,
        `Reason: ${quote(reason)}`,
      ],
    };
  });
}

/** One line per unmet requirement, with chunk ids resolved to `path:start-end name` where the result knows them. */
export function unmetLines(result: ScopeResult, quote: Quote): string[] {
  const label = labeler(result, quote);
  return result.unmetCoherence.map(
    (entry) =>
      `${label(entry.chunkId)} needs ${label(entry.requiredId)}: ${
        entry.reason === "too-large" ? "too large to include as a supporting declaration" : "did not fit the budget"
      } (${entry.reason})`,
  );
}
