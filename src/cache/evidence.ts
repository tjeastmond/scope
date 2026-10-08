import type { CodeChunk } from "../types.ts";
import { readFeedback, type FeedbackRecord, type FeedbackSource } from "./feedback.ts";
import { contentFingerprint, readHistory, type HistoryRecord } from "./history.ts";
import type { RepositoryCache } from "./location.ts";

/**
 * Evidence about chunks from past runs (#77), in three classes that live in separate fields so no code can mistake
 * one for another:
 *
 * - predictions: what Scope itself did (selected, supported, skipped). Repeating its own output proves nothing.
 * - Jev judgments: the relevance Jev gave. A high score is a model's opinion, not proof of usefulness.
 * - external feedback: what a user or an agent reported after a run. Only this confirms usefulness.
 *
 * Chunk ids are not content-addressed, so every observation carries the fingerprint of the content it was about and
 * counts only while the chunk exists now with that same content. Deleted or edited code carries no evidence.
 *
 * Nothing in selection reads this before #74. The inputs are the retention-bounded history and feedback, so the
 * summary is bounded too; nothing new is stored.
 */

export interface PredictionEvidence {
  selected: number;
  support: number;
  skipped: number;
}

export interface JevEvidence {
  /** Runs in which Jev gave this chunk a relevance. */
  judged: number;
  meanRelevance?: number;
  maxRelevance?: number;
}

export interface FeedbackEvidence {
  useful: number;
  irrelevant: number;
  /** A `--missing` symbol counts once for each chunk it resolved to. */
  missing: number;
  /** Distinct sources: the user, and each distinct agent name. */
  sources: number;
  /** Milliseconds since the epoch of the latest counted feedback. */
  lastTime?: number;
}

export interface ChunkEvidence {
  chunkId: string;
  /** The current content fingerprint every counted observation was validated against. */
  fingerprint: string;
  /** Scope's own output. Never confirmation. */
  predictions: PredictionEvidence;
  /** Jev's judgments. Never confirmation. */
  jev: JevEvidence;
  /** External observations. The only confirmation. */
  feedback: FeedbackEvidence;
}

/** A `--missing` location given as a path (optionally a line range), for a file that is still included. */
export interface MissingLocation {
  path: string;
  startLine?: number;
  endLine?: number;
  /** Feedback entries naming this exact location. */
  count: number;
}

export interface EvidenceSummary {
  /** Only chunks present now whose content matches an observation; ordered by chunk id. */
  chunks: Map<string, ChunkEvidence>;
  /** Path-level `--missing` observations for files still included now. Empty when no current files are given. */
  missingLocations: MissingLocation[];
  /** Observations dropped because the chunk is gone, its content changed, or the feedback was already out of date. */
  stale: { observations: number };
}

interface Accumulator {
  fingerprint: string;
  predictions: PredictionEvidence;
  relevances: number[];
  feedback: { useful: number; irrelevant: number; missing: number };
  sources: Set<string>;
  lastTime?: number;
}

const sourceKey = (source: FeedbackSource) => (source.kind === "user" ? "user" : `agent:${source.name}`);

/**
 * Gathers the evidence for the chunks that exist now. `current` maps each present chunk id to its content
 * fingerprint; `currentFiles` are the included text files, for path-level `--missing` entries. The result does not
 * depend on the order of the inputs.
 */
export function collectEvidence(
  history: readonly HistoryRecord[],
  feedback: readonly FeedbackRecord[],
  current: ReadonlyMap<string, string>,
  currentFiles?: ReadonlySet<string>,
): EvidenceSummary {
  const found = new Map<string, Accumulator>();
  let stale = 0;
  /** The accumulator of a chunk whose recorded content still matches, or undefined (and the observation is stale). */
  const valid = (chunkId: string, fingerprint: string): Accumulator | undefined => {
    if (current.get(chunkId) !== fingerprint) {
      stale++;
      return undefined;
    }
    let entry = found.get(chunkId);
    if (!entry) {
      entry = {
        fingerprint,
        predictions: { selected: 0, support: 0, skipped: 0 },
        relevances: [],
        feedback: { useful: 0, irrelevant: 0, missing: 0 },
        sources: new Set(),
      };
      found.set(chunkId, entry);
    }
    return entry;
  };

  for (const record of history) {
    for (const candidate of record.candidates) {
      const entry = valid(candidate.chunkId, candidate.fingerprint);
      if (!entry) continue;
      entry.predictions[candidate.decision]++;
      if (candidate.relevance !== undefined) entry.relevances.push(candidate.relevance);
    }
  }

  const locations = new Map<string, MissingLocation>();
  for (const record of feedback) {
    const key = sourceKey(record.source);
    const count = (entry: Accumulator | undefined, kind: "useful" | "irrelevant" | "missing") => {
      if (!entry) return;
      entry.feedback[kind]++;
      entry.sources.add(key);
      entry.lastTime = Math.max(entry.lastTime ?? record.time, record.time);
    };
    for (const kind of ["useful", "irrelevant"] as const) {
      for (const ref of record[kind]) {
        // Given about code that had already changed: it may describe other code, so it counts for nothing.
        if (!ref.current) stale++;
        else count(valid(ref.chunkId, ref.fingerprint), kind);
      }
    }
    for (const missing of record.missing) {
      if ("symbol" in missing) {
        for (const ref of missing.chunks) count(valid(ref.chunkId, ref.fingerprint), "missing");
        continue;
      }
      if (!currentFiles?.has(missing.path)) {
        stale++;
        continue;
      }
      const id = JSON.stringify([missing.path, missing.startLine ?? null, missing.endLine ?? null]);
      const location = locations.get(id);
      if (location) location.count++;
      else {
        locations.set(id, {
          path: missing.path,
          ...(missing.startLine === undefined ? {} : { startLine: missing.startLine, endLine: missing.endLine }),
          count: 1,
        });
      }
    }
  }

  const chunks = new Map<string, ChunkEvidence>();
  for (const chunkId of [...found.keys()].sort()) {
    const entry = found.get(chunkId)!;
    // Sorted before summing so the mean does not depend on the order of the history.
    const relevances = entry.relevances.slice().sort((a, b) => a - b);
    chunks.set(chunkId, {
      chunkId,
      fingerprint: entry.fingerprint,
      predictions: entry.predictions,
      jev: {
        judged: relevances.length,
        ...(relevances.length === 0
          ? {}
          : {
              meanRelevance: relevances.reduce((sum, value) => sum + value, 0) / relevances.length,
              maxRelevance: relevances[relevances.length - 1],
            }),
      },
      feedback: {
        ...entry.feedback,
        sources: entry.sources.size,
        ...(entry.lastTime === undefined ? {} : { lastTime: entry.lastTime }),
      },
    });
  }
  const order = (a: MissingLocation, b: MissingLocation) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0);
  return { chunks, missingLocations: [...locations.values()].sort(order), stale: { observations: stale } };
}

/**
 * Confirmed useful: external feedback that the chunk helped or was missing outweighs feedback that it was irrelevant.
 * Takes only {@link FeedbackEvidence}, so a prediction count or a Jev score cannot reach it. A tie is neither
 * confirmed useful nor confirmed irrelevant.
 */
export const isConfirmedUseful = (feedback: FeedbackEvidence): boolean =>
  feedback.useful + feedback.missing > feedback.irrelevant;

/** Confirmed irrelevant: irrelevant reports outweigh useful and missing ones. A tie is neither. */
export const isConfirmedIrrelevant = (feedback: FeedbackEvidence): boolean =>
  feedback.irrelevant > feedback.useful + feedback.missing;

/**
 * Reads the verified history and feedback and validates them against `chunks`, the current source. `files` are the
 * included text files (default: the files of `chunks`). `warnings` are what the readers skipped.
 */
export async function loadEvidence(
  cache: RepositoryCache,
  chunks: readonly CodeChunk[],
  files?: Iterable<string>,
): Promise<{ summary: EvidenceSummary; warnings: string[] }> {
  const [history, feedback] = await Promise.all([readHistory(cache), readFeedback(cache)]);
  const current = new Map(chunks.map((chunk) => [chunk.id, contentFingerprint(chunk.content)]));
  const summary = collectEvidence(
    history.records,
    feedback.records,
    current,
    new Set(files ?? chunks.map((chunk) => chunk.file)),
  );
  return { summary, warnings: [...history.warnings, ...feedback.warnings] };
}
