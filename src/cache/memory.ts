import { DEFAULT_RETRIEVAL_CONFIG, type MemoryConfig } from "../retrieval/config.ts";
import type { CandidateSelection } from "../retrieval/candidates.ts";
import { extractTaskTerms } from "../retrieval/terms.ts";
import type { CodeChunk } from "../types.ts";
import { collectEvidence, isConfirmedIrrelevant, isConfirmedUseful } from "./evidence.ts";
import { readFeedback, type FeedbackRecord } from "./feedback.ts";
import {
  MAX_TERM_CHARS,
  MAX_TERMS,
  MAX_TASK_CHARS,
  contentFingerprint,
  readHistory,
  redactCredentials,
  type HistoryRecord,
} from "./history.ts";
import type { RepositoryCache } from "./location.ts";

/**
 * Retrieval memory (#74): history and feedback as extra candidate signals. Memory only ever adds: the fresh shortlist
 * is kept whole and in order, and up to `maxCandidates` remembered chunks are appended after it, so unseen code stays
 * as discoverable as without history. Memory reads the existing, retention-bounded history and feedback and stores
 * nothing.
 *
 * A remembered chunk must exist now with the content fingerprint it was recorded with (#77), so deleted or edited code
 * never returns from memory. Sources, strongest first, each from a prior run whose task is similar to this one:
 *   a. `--missing` feedback (a symbol, or the chunks of a file or range),
 *   b. chunks confirmed useful by external feedback,
 *   c. chunks Jev selected, with no confirmed-irrelevant feedback.
 * Predictions and Jev scores are never confirmation: only (a) and (b), which come from feedback, earn the full memory
 * signal; (c) earns half.
 */

export const FEEDBACK_SIGNAL = 1;
export const JEV_SIGNAL = 0.5;
const LABEL = "memory:";

/** How memory ranked a chunk; also what the result's `signals` and `origin` are built from. */
export interface RankedChunk {
  chunkId: string;
  signals: Record<string, number>;
  total: number;
  origin: string;
}

/** Whether memory is on: any `SCOPE_MEMORY` value but `off` leaves it on. */
export const memoryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SCOPE_MEMORY !== "off";

type Source = "missing" | "useful" | "jev";
const SOURCE_RANK: Record<Source, number> = { missing: 0, useful: 1, jev: 2 };

/** The `exact` and `words` terms as one lowercased set, capped as history caps them. */
function termSet(terms: { exact: string[]; words: string[] }): Set<string> {
  const cap = (list: string[]) => list.slice(0, MAX_TERMS).map((term) => term.slice(0, MAX_TERM_CHARS));
  return new Set([...cap(terms.exact), ...cap(terms.words)].map((term) => term.toLowerCase()));
}

/**
 * Jaccard similarity of two tasks: the size of the intersection over the size of the union of their `exact` and `words`
 * terms (lowercased, as one set each). Two empty term sets have similarity 0.
 */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareChunks = (a: CodeChunk, b: CodeChunk) =>
  compareStrings(a.file, b.file) || a.startLine - b.startLine || compareStrings(a.id, b.id);

export interface MemoryInput {
  task: string;
  /** Every chunk of the current scan. */
  chunks: readonly CodeChunk[];
  /** The included text files, for path-level `--missing` entries. */
  files: ReadonlySet<string>;
  fresh: Pick<CandidateSelection, "candidates" | "ranking">;
  history: readonly HistoryRecord[];
  feedback: readonly FeedbackRecord[];
  config: MemoryConfig;
}

export interface MemoryOutcome {
  /** The fresh shortlist unchanged, then the memory candidates. */
  candidates: CodeChunk[];
  /** Retrieval's ranking of each fresh candidate (unchanged) and memory's of each added one. */
  ranking: Map<string, RankedChunk>;
  /** Chunk ids added by memory, in order. */
  added: string[];
}

/** The shortlist with memory candidates appended. Pure and deterministic; the clock plays no part. */
export function addMemoryCandidates(input: MemoryInput): MemoryOutcome {
  const { fresh, config } = input;
  const ranking = new Map<string, RankedChunk>(fresh.ranking);
  const unchanged: MemoryOutcome = { candidates: [...fresh.candidates], ranking, added: [] };
  if (config.maxCandidates <= 0 || input.history.length === 0) return unchanged;

  // The same redaction history applies, so the terms are comparable with the stored ones.
  const redactedTask = redactCredentials(input.task);
  const taskTerms = termSet(extractTaskTerms(redactedTask));
  // History stores at most MAX_TASK_CHARS of a task, so two tasks are known to be identical only when neither was cut.
  // A long task's repeat is then treated as a related task: correct, at the cost of one fresh Jev review.
  const truncated = redactedTask.length > MAX_TASK_CHARS;
  const isSameTask = (record: HistoryRecord) =>
    !truncated && !record.task.truncated && record.task.text === redactedTask;
  const scores = new Map<string, number>();
  const ranked = input.history
    .map((record) => ({ record, score: similarity(taskTerms, termSet(record.task.terms)) }))
    .filter(({ score }) => score >= config.similarityMin)
    // Newest first (run ids sort by time).
    .sort((a, b) => compareStrings(b.record.runId, a.record.runId));
  // Runs of this very task and runs of other similar tasks each get their own window of the newest `maxRuns`, so
  // repeating a task never pushes the related runs that shaped its shortlist out of the window (which would change the
  // payload of an identical repeat and forfeit decision reuse, #75).
  const sameTask = ranked.filter(({ record }) => isSameTask(record)).slice(0, config.maxRuns);
  const otherTasks = ranked.filter(({ record }) => !isSameTask(record)).slice(0, config.maxRuns);
  const similar = [...sameTask, ...otherTasks];
  for (const { record, score } of similar) scores.set(record.runId, score);
  if (similar.length === 0) return unchanged;

  const byId = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const current = new Map(input.chunks.map((chunk) => [chunk.id, contentFingerprint(chunk.content)]));
  const feedback = input.feedback.filter((record) => scores.has(record.runId));
  // Confirmation comes from the feedback on similar runs only, validated against the current content.
  const evidence = collectEvidence(
    similar.map(({ record }) => record),
    feedback,
    current,
    input.files,
  ).chunks;
  const irrelevant = (id: string) => {
    const found = evidence.get(id);
    return found !== undefined && isConfirmedIrrelevant(found.feedback);
  };
  const found = new Map<string, { source: Source; score: number; runId: string }>();
  const offer = (id: string, source: Source, runId: string) => {
    if (!byId.has(id) || irrelevant(id)) return;
    const score = scores.get(runId)!;
    const best = found.get(id);
    // Strongest source first, then the more similar run, then the newer one.
    const wins =
      best === undefined ||
      SOURCE_RANK[source] - SOURCE_RANK[best.source] < 0 ||
      (source === best.source && (score > best.score || (score === best.score && runId > best.runId)));
    if (wins) found.set(id, { source, score, runId });
  };

  for (const record of feedback) {
    // A symbol, path or range offers the chunks it resolved to, each only while its content is unchanged.
    for (const missing of record.missing) {
      for (const ref of missing.chunks) {
        if (current.get(ref.chunkId) === ref.fingerprint) offer(ref.chunkId, "missing", record.runId);
      }
    }
    for (const ref of record.useful) {
      const confirmed = evidence.get(ref.chunkId);
      if (
        ref.current &&
        current.get(ref.chunkId) === ref.fingerprint &&
        confirmed &&
        isConfirmedUseful(confirmed.feedback)
      ) {
        offer(ref.chunkId, "useful", record.runId);
      }
    }
  }
  // A run of this very task already judged this shortlist; offering its selection again would change the payload of an
  // identical repeat and forfeit decision reuse (#75). Its feedback still counts above.
  for (const { record } of otherTasks) {
    for (const candidate of record.candidates) {
      if (candidate.decision === "selected" && current.get(candidate.chunkId) === candidate.fingerprint) {
        offer(candidate.chunkId, "jev", record.runId);
      }
    }
  }

  const present = new Set(fresh.candidates.map((chunk) => chunk.id));
  const ordered = [...found.entries()]
    .filter(([id]) => !present.has(id))
    .sort(
      ([idA, a], [idB, b]) =>
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        b.score - a.score ||
        compareChunks(byId.get(idA)!, byId.get(idB)!),
    )
    .slice(0, config.maxCandidates);

  const zeros = Object.fromEntries(Object.keys(DEFAULT_RETRIEVAL_CONFIG.weights).map((name) => [name, 0]));
  for (const [id, { source, runId }] of ordered) {
    const signal = source === "jev" ? JEV_SIGNAL : FEEDBACK_SIGNAL;
    const base = fresh.ranking.get(id);
    ranking.set(id, {
      chunkId: id,
      signals: { ...(base?.signals ?? zeros), memory: signal },
      total: base?.total ?? 0,
      origin: source === "missing" ? `${LABEL} missing in similar task ${runId}` : `${LABEL} similar task ${runId}`,
    });
  }
  return {
    candidates: [...fresh.candidates, ...ordered.map(([id]) => byId.get(id)!)],
    ranking,
    added: ordered.map(([id]) => id),
  };
}

/**
 * Reads the verified history and feedback and adds memory candidates to the fresh shortlist. Never throws: the readers
 * skip what they cannot trust, and `warnings` say what they skipped. Memory is off for `SCOPE_MEMORY=off`, for a
 * `maxCandidates` of 0, and for a store that is fresh (reset: it holds no usable history).
 */
export async function withMemory(
  cache: RepositoryCache,
  input: Omit<MemoryInput, "history" | "feedback">,
  env?: NodeJS.ProcessEnv,
): Promise<MemoryOutcome & { warnings: string[] }> {
  const off = !memoryEnabled(env) || input.config.maxCandidates <= 0 || cache.fresh;
  if (off) return { ...addMemoryCandidates({ ...input, history: [], feedback: [] }), warnings: [] };
  const [history, feedback] = await Promise.all([readHistory(cache), readFeedback(cache)]);
  const outcome = addMemoryCandidates({ ...input, history: history.records, feedback: feedback.records });
  return { ...outcome, warnings: [...new Set([...history.warnings, ...feedback.warnings])] };
}
