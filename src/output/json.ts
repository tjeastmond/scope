import { signalPairs } from "./report.ts";
import type {
  ChunkKind,
  Language,
  ScopeMode,
  ScopeResult,
  SelectedChunk,
  SkippedChunk,
  UnmetCoherence,
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
  /** `--explain` only: the retrieval signals (keys sorted), how the chunk was found, and its own cost. */
  signals?: Record<string, number>;
  origin?: string;
  estimatedTokens?: number;
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
  schemaVersion: 1;
  mode: ScopeMode;
  task: string;
  budget: number;
  estimator: string;
  estimatedTokens: number;
  characters: number;
  lines: number;
  regions: JsonRegion[];
  warnings: string[];
  unmetCoherence: UnmetCoherence[];
  skipped: SkippedChunk[];
  retrievalConfigVersion?: string;
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
  score,
  reason,
  ...(supportFor === undefined ? {} : { supportFor }),
  ...(explain
    ? {
        signals: Object.fromEntries(signalPairs(signals)),
        ...(origin === undefined ? {} : { origin }),
        estimatedTokens: chunk.estimatedTokens,
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
  estimatedTokens: item.estimatedTokens,
  reason: item.reason,
  ...(item.minimumBudget === undefined ? {} : { minimumBudget: item.minimumBudget }),
});

export function toJsonPayload(result: ScopeResult): JsonPayload {
  const byId = new Map(result.chunks.map((item) => [item.chunk.id, item]));
  return {
    schemaVersion: 1,
    mode: result.mode,
    task: result.task,
    budget: result.budget,
    estimator: result.estimator,
    estimatedTokens: result.estimatedTokens,
    characters: result.characters,
    lines: result.lines,
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
    unmetCoherence: result.unmetCoherence.map(({ chunkId, requiredId, reason }) => ({ chunkId, requiredId, reason })),
    skipped: result.skipped.map(toJsonSkipped),
    ...(result.retrievalConfigVersion === undefined ? {} : { retrievalConfigVersion: result.retrievalConfigVersion }),
    ...(result.explain ? { explain: true as const } : {}),
  };
}

/** The versioned JSON form of a result: two-space indented, newline terminated. */
export const renderJson = (result: ScopeResult): string => `${JSON.stringify(toJsonPayload(result), null, 2)}\n`;
