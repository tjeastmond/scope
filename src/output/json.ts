import { signalPairs } from "./report.ts";
import type {
  CacheReport,
  ChunkKind,
  JevMetrics,
  Language,
  MemoryReason,
  ScopeMode,
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
  score: number;
  reason: string;
  supportFor?: string[];
  /** Why retrieval memory offered the chunk; present only for memory-assisted chunks (#79). */
  memory?: MemoryReason;
  /** `--explain` only: the retrieval signals (keys sorted) and how the chunk was found. */
  signals?: Record<string, number>;
  origin?: string;
}

/** An emitted block of source. The content lives here once; no line is repeated across regions or chunks. */
export interface JsonRegion {
  file: string;
  language: Language;
  startLine: number;
  endLine: number;
  content: string;
  chunks: JsonChunk[];
}

/**
 * The JSON document. `schemaVersion` is bumped on any breaking change (removed or renamed key, changed meaning or
 * type); additive fields are declared here and in `docs/scope-result.schema.json`. See docs/output-formats.md.
 */
export interface JsonPayload {
  schemaVersion: 2;
  mode: ScopeMode;
  task: string;
  regions: JsonRegion[];
  warnings: string[];
  skipped: SkippedChunk[];
  retrievalConfigVersion?: string;
  /** Version of the Jev question text and criteria; absent in `no-jev` mode. */
  jevQuestionVersion?: string;
  /**
   * Jev's overhead, separate from the selected context; absent in `no-jev` mode and when Jev was not called. `latencyMs`
   * is the wall clock of the whole decision (requests overlap); tokens are as reported by Jev. No cost is reported.
   */
  jev?: JevMetrics;
  /** ISO 8601 UTC time of the stored Jev decision this run reused; absent when Jev was asked. */
  decisionsReusedFrom?: string;
  /** Id of the run's history record, the handle for `scope feedback`; absent when the run recorded none. */
  runId?: string;
  /** What the cache did for this run; absent with the cache off (#79). */
  cache?: CacheReport;
  /** Present (true) only under `--explain`. */
  explain?: true;
}

// Keys are written out explicitly so their order is fixed and the output deterministic.
const toJsonMemory = ({ source, runId, similarity, feedback }: MemoryReason): MemoryReason => ({
  source,
  runId,
  similarity,
  ...(feedback === undefined
    ? {}
    : {
        feedback: {
          useful: feedback.useful,
          irrelevant: feedback.irrelevant,
          missing: feedback.missing,
          sources: [...feedback.sources],
        },
      }),
});

// Keys are written out explicitly so their order is fixed and the output deterministic.
const toJsonCache = ({ versions, cold, files, decision, memory, weights }: CacheReport): CacheReport => ({
  versions: Object.fromEntries(Object.entries(versions)),
  cold,
  files: {
    reused: files.reused,
    refreshed: files.refreshed,
    removed: files.removed,
    refreshedPaths: [...files.refreshedPaths],
    ...(files.refreshedTruncated ? { refreshedTruncated: true as const } : {}),
  },
  ...(decision === undefined
    ? {}
    : {
        decision: {
          reused: decision.reused,
          ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        },
      }),
  ...(memory === undefined
    ? {}
    : { memory: { candidates: memory.candidates, ...(memory.disabled ? { disabled: memory.disabled } : {}) } }),
  ...(weights === undefined ? {} : { weights: { version: weights.version } }),
});

const toJsonChunk = (
  { chunk, relevance, score, reason, supportFor, signals, origin, memory }: SelectedChunk,
  explain: boolean,
): JsonChunk => ({
  id: chunk.id,
  ...(chunk.name === undefined ? {} : { name: chunk.name }),
  kind: chunk.kind,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  ...(relevance === undefined ? {} : { relevance }),
  score,
  reason,
  ...(supportFor === undefined ? {} : { supportFor }),
  ...(memory === undefined ? {} : { memory: toJsonMemory(memory) }),
  ...(explain
    ? {
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
  return {
    schemaVersion: 2,
    mode: result.mode,
    task: result.task,
    regions: result.regions.map((region) => ({
      file: region.file,
      language: region.language,
      startLine: region.startLine,
      endLine: region.endLine,
      content: region.content,
      chunks: region.chunkIds.map((id) => {
        const found = byId.get(id);
        if (!found) throw new Error(`Region ${region.file}:${region.startLine} names unknown chunk ${id}`);
        return toJsonChunk(found, result.explain === true);
      }),
    })),
    warnings: result.warnings,
    skipped: result.skipped.map(toJsonSkipped),
    ...(result.retrievalConfigVersion === undefined ? {} : { retrievalConfigVersion: result.retrievalConfigVersion }),
    ...(result.jevQuestionVersion === undefined ? {} : { jevQuestionVersion: result.jevQuestionVersion }),
    ...(result.jev === undefined ? {} : { jev: toJsonJev(result.jev) }),
    ...(result.decisionsReusedFrom === undefined ? {} : { decisionsReusedFrom: result.decisionsReusedFrom }),
    ...(result.runId === undefined ? {} : { runId: result.runId }),
    ...(result.cache === undefined ? {} : { cache: toJsonCache(result.cache) }),
    ...(result.explain ? { explain: true as const } : {}),
  };
}

/** The versioned JSON form of a result: two-space indented, newline terminated. */
export const renderJson = (result: ScopeResult): string => `${JSON.stringify(toJsonPayload(result), null, 2)}\n`;
