import { MIN_RELEVANCE } from "../config.ts";
import { byLocation } from "../output/text.ts";
import type { CodeChunk, ScopeMode, ScopeResult, SelectedChunk, SkippedChunk } from "../types.ts";
import { requiredSupports } from "./coherence.ts";
import { mergeRegions, toScopeRegion } from "./regions.ts";

export interface SelectionOptions {
  task: string;
  mode: ScopeMode;
  /** Every chunk of the repository by id, so supporting declarations outside the shortlist can be found. */
  chunks: ReadonlyMap<string, CodeChunk>;
  minScore?: number;
  /** Warnings that precede the selection's own (scan, retrieval). */
  leadingWarnings?: readonly string[];
  /** Reported in the JSON artifact. */
  retrievalConfigVersion?: string;
  /** Reported in the JSON artifact; set only on the Jev path. */
  jevQuestionVersion?: string;
  /** `--explain`: the artifact carries selection evidence. */
  explain?: boolean;
}

const noRelevantWarning = (minScore: number, candidates: number) =>
  candidates === 0
    ? "No relevant chunks found; the result is empty."
    : `No relevant chunks found: no candidate scored at least ${minScore}; the result is empty.`;

/** Skipped chunks in the order the artifact lists them: by file, start line, then id. */
const bySkipLocation = (a: SkippedChunk, b: SkippedChunk) =>
  a.file.localeCompare(b.file) || a.startLine - b.startLine || a.chunkId.localeCompare(b.chunkId);

/** A declaration included only because selected chunks need it; it was not judged, so it has no relevance. */
function supportEntry(chunk: CodeChunk, requirers: ReadonlyMap<string, CodeChunk>): SelectedChunk {
  const supported = [...requirers.values()].sort((a, b) => a.id.localeCompare(b.id));
  const names = supported.map((required) => required.name ?? required.file).join(", ");
  return {
    chunk,
    signals: {},
    score: 0,
    reason: `Supporting declaration for ${names}`,
    supportFor: supported.map((required) => required.id),
  };
}

/** A candidate that scored under the relevance minimum, with its relevance so the omission is inspectable. */
function skippedEntry({ chunk, relevance, score }: SelectedChunk): SkippedChunk {
  return {
    chunkId: chunk.id,
    file: chunk.file,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    ...(chunk.name === undefined ? {} : { name: chunk.name }),
    ...(relevance === undefined ? {} : { relevance }),
    score,
  };
}

/**
 * Includes every candidate that scored at least the relevance minimum, plus the supporting declarations they need
 * (see `requiredSupports`), whatever they cost: Scope sends everything it believes belongs to the edit and leaves size
 * accounting to the consumer (docs/selection-policy.md). Chunks are never truncated. Touching or overlapping chunks
 * are merged into regions, so a line is never printed twice. Candidates below the minimum are recorded in `skipped`.
 */
export function selectByRelevance(candidates: readonly SelectedChunk[], options: SelectionOptions): ScopeResult {
  const { task, mode, chunks, minScore = MIN_RELEVANCE } = options;
  const eligible = candidates.filter((item) => item.score >= minScore);
  const leadingWarnings = options.leadingWarnings ?? [];

  // Supports that are not themselves relevant: chunk id to the relevant chunks that need it. A support that is
  // relevant keeps its own judgment and label.
  const eligibleIds = new Set(eligible.map((item) => item.chunk.id));
  const supported = new Map<string, { chunk: CodeChunk; requirers: Map<string, CodeChunk> }>();
  for (const { chunk } of eligible) {
    for (const support of requiredSupports(chunk, chunks)) {
      if (eligibleIds.has(support.id)) continue;
      const entry = supported.get(support.id) ?? { chunk: support, requirers: new Map<string, CodeChunk>() };
      entry.requirers.set(chunk.id, chunk);
      supported.set(support.id, entry);
    }
  }
  const selected = [
    ...eligible,
    ...[...supported.values()].map(({ chunk, requirers }) => supportEntry(chunk, requirers)),
  ].sort(byLocation);

  // A below-threshold chunk can still be included as another chunk's support; it is not skipped then.
  const skipped = candidates
    .filter((item) => item.score < minScore && !supported.has(item.chunk.id))
    .map(skippedEntry)
    .sort(bySkipLocation);
  const warnings = [
    ...leadingWarnings,
    ...(eligible.length === 0 ? [noRelevantWarning(minScore, candidates.length)] : []),
  ];
  const regions = mergeRegions(selected).map(toScopeRegion);

  return {
    schemaVersion: 2,
    mode,
    task,
    chunks: selected,
    regions,
    warnings,
    skipped,
    ...(options.retrievalConfigVersion === undefined ? {} : { retrievalConfigVersion: options.retrievalConfigVersion }),
    ...(options.jevQuestionVersion === undefined ? {} : { jevQuestionVersion: options.jevQuestionVersion }),
    ...(options.explain ? { explain: true as const } : {}),
  };
}
