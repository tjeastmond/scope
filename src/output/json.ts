import { mostRelevantFirst, rankRegions, regionRelevance, signalPairs } from "./report.ts";
import type {
  ChunkKind,
  JevMetrics,
  Language,
  ScopeMode,
  ScopeRegion,
  ScopeResult,
  SelectedChunk,
  SkippedChunk,
} from "../types.ts";

/** Provenance of one chunk inside a region. `relevance` is absent in `no-jev` mode; `score` is not a probability. */
export interface JsonChunk {
  id: string;
  name?: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  relevance?: number;
  supportFor?: string[];
  /** `--explain` only: the ranking score, the inclusion reason, the retrieval signals (keys sorted) and the origin. */
  score?: number;
  reason?: string;
  signals?: Record<string, number>;
  origin?: string;
}

/** An emitted block of source. The content lives here once; no line is repeated across regions or chunks. */
export interface JsonRegion {
  file: string;
  language: Language;
  startLine: number;
  endLine: number;
  /** Highest chunk `relevance` in the region; absent when none of its chunks was judged (`no-jev`). */
  relevance?: number;
  content: string;
  chunks: JsonChunk[];
}

/**
 * The JSON document. `schemaVersion` is bumped on any breaking change (removed or renamed key, changed meaning or
 * type); additive fields are declared here and in `docs/scope-result.schema.json`. See docs/output-formats.md.
 */
export interface JsonPayload {
  schemaVersion: 4;
  mode: ScopeMode;
  task: string;
  regions: JsonRegion[];
  warnings: string[];
  /** Present only under `--explain`; most relevant first. */
  skipped?: SkippedChunk[];
  retrievalConfigVersion?: string;
  /** Version of the Jev question text and criteria; absent in `no-jev` mode. */
  jevQuestionVersion?: string;
  /**
   * Jev's overhead, separate from the selected context; absent in `no-jev` mode and when Jev was not called. `latencyMs`
   * is the wall clock of the whole decision (requests overlap); tokens are as reported by Jev. No cost is reported.
   */
  jev?: JevMetrics;
  /** Present (true) only under `--explain`. */
  explain?: true;
}

const toJsonChunk = (
  { chunk, relevance, score, reason, supportFor, signals, origin }: SelectedChunk,
  explain: boolean,
): JsonChunk => ({
  id: chunk.id,
  ...(chunk.name === undefined ? {} : { name: chunk.name }),
  kind: chunk.kind,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  ...(relevance === undefined ? {} : { relevance }),
  ...(supportFor === undefined ? {} : { supportFor }),
  ...(explain
    ? {
        score,
        reason,
        signals: Object.fromEntries(signalPairs(signals)),
        ...(origin === undefined ? {} : { origin }),
      }
    : {}),
});

// Keys are written out explicitly so their order is fixed and the output deterministic.
const toJsonSkipped = (item: SkippedChunk): SkippedChunk => ({
  chunkId: item.chunkId,
  file: item.file,
  startLine: item.startLine,
  endLine: item.endLine,
  ...(item.name === undefined ? {} : { name: item.name }),
  ...(item.relevance === undefined ? {} : { relevance: item.relevance }),
  score: item.score,
});

// Keys are written out explicitly so their order is fixed and the output deterministic.
const toJsonJev = ({ requestCount, latencyMs, usage, requests }: JevMetrics): JevMetrics => ({
  ...(requestCount === undefined ? {} : { requestCount }),
  latencyMs,
  usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  ...(requests === undefined
    ? {}
    : {
        requests: requests.map((r) => ({
          latencyMs: r.latencyMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
        })),
      }),
});

export function toJsonPayload(result: ScopeResult): JsonPayload {
  const byId = new Map(result.chunks.map((item) => [item.chunk.id, item]));
  const chunksOf = (region: ScopeRegion): SelectedChunk[] =>
    region.chunkIds.map((id) => {
      const found = byId.get(id);
      if (!found) throw new Error(`Region ${region.file}:${region.startLine} names unknown chunk ${id}`);
      return found;
    });
  return {
    schemaVersion: 4,
    mode: result.mode,
    task: result.task,
    regions: rankRegions(result.regions, chunksOf).map((region) => {
      const chunks = chunksOf(region);
      const relevance = regionRelevance(chunks);
      return {
        file: region.file,
        language: region.language,
        startLine: region.startLine,
        endLine: region.endLine,
        ...(relevance === undefined ? {} : { relevance }),
        content: region.content,
        chunks: chunks.map((item) => toJsonChunk(item, result.explain === true)),
      };
    }),
    warnings: result.warnings,
    ...(result.explain ? { skipped: mostRelevantFirst(result.skipped).map(toJsonSkipped) } : {}),
    ...(result.retrievalConfigVersion === undefined ? {} : { retrievalConfigVersion: result.retrievalConfigVersion }),
    ...(result.jevQuestionVersion === undefined ? {} : { jevQuestionVersion: result.jevQuestionVersion }),
    ...(result.jev === undefined ? {} : { jev: toJsonJev(result.jev) }),
    ...(result.explain ? { explain: true as const } : {}),
  };
}

/** The versioned JSON form of a result: two-space indented, newline terminated. */
export const renderJson = (result: ScopeResult): string => `${JSON.stringify(toJsonPayload(result), null, 2)}\n`;
