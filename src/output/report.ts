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

/** Mode, region count and retrieval version; the same facts in every human-readable format. */
export function summaryLines(result: ScopeResult, quote: Quote): string[] {
  const { mode, regions, retrievalConfigVersion, jevQuestionVersion, jev, decisionsReusedFrom } = result;
  return [
    `Mode: ${mode}`,
    `Regions: ${regions.length}`,
    // Always shown: a reused decision is never silent.
    ...(decisionsReusedFrom === undefined
      ? []
      : [
          `Decisions reused from ${decisionsReusedFrom} (identical task, candidates and versions; run with --fresh to ask Jev again)`,
        ]),
    ...(retrievalConfigVersion === undefined ? [] : [`Retrieval config: ${quote(retrievalConfigVersion)}`]),
    ...(jevQuestionVersion === undefined ? [] : [`Jev questions: ${quote(jevQuestionVersion)}`]),
    // Overhead of the external service, not part of the selected context; shown under --explain only.
    ...(result.explain && jev
      ? [
          ...(jev.requestCount === undefined ? [] : [`Jev requests: ${jev.requestCount}`]),
          `Jev latency: ${jev.latencyMs} ms (wall clock)`,
          `Jev tokens: ${jev.usage.inputTokens} input / ${jev.usage.outputTokens} output`,
        ]
      : []),
  ];
}

export const location = (
  entry: { file: string; startLine: number; endLine: number; name?: string },
  quote: Quote,
): string => quote(`${entry.file}:${entry.startLine}-${entry.endLine}${entry.name ? ` ${entry.name}` : ""}`);

/** Most relevant first, ties by location. */
const mostRelevantFirst = (entries: SkippedChunk[]): SkippedChunk[] =>
  [...entries].sort(
    (a, b) =>
      (b.relevance ?? b.score) - (a.relevance ?? a.score) ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.chunkId.localeCompare(b.chunkId),
  );

/**
 * Below-threshold skips are expected filtering, so by default they are only counted. Under `--explain` every one is
 * listed, most relevant first (there are at most as many as the retrieval shortlist).
 */
export function belowThresholdLines(result: ScopeResult, quote: Quote): string[] {
  if (result.skipped.length === 0) return [];
  if (!result.explain)
    return [`${result.skipped.length} candidate(s) scored below the relevance minimum and are not listed.`];
  return mostRelevantFirst(result.skipped).map(
    (entry) => `${location(entry, quote)} (${scoreLabel(entry.relevance, entry.score)}): below the relevance minimum`,
  );
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
        `Origin: ${source}`,
        `Reason: ${quote(reason)}`,
      ],
    };
  });
}
