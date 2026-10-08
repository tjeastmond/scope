import { readdir } from "node:fs/promises";
import { isRunId, newRunId } from "./history.ts";
import { macEquals, recordMac } from "./integrity.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import { resolveRetention } from "./retention.ts";
import type { CommitOutcome, DocumentType } from "./store.ts";

/**
 * Feedback (#76): one signed document per submission, `feedback-<feedbackId>`. A submission is an attributed
 * observation by a user or an agent about the chunks one earlier run selected: which were useful, which were
 * irrelevant, and what was missing. It is recorded and counted, and #77 reads it as the only confirmation of usefulness (src/cache/evidence.ts).
 *
 * A record holds ids, paths, line ranges, symbol names and booleans. Never source code, the task text, raw Jev
 * responses, environment variables or keys.
 */

export const FEEDBACK_PREFIX = "feedback-";
/** Version of the record shape; a record of another version is ignored. */
export const FEEDBACK_RECORD_VERSION = 2;
/** Entries per list (useful, irrelevant, missing). */
export const MAX_FEEDBACK_ENTRIES = 200;
/** Characters per entry (chunk id, path, symbol name). */
export const MAX_FEEDBACK_ENTRY_CHARS = 500;
/** Characters of an agent name. */
export const MAX_AGENT_NAME_CHARS = 100;
/** Chunks one `--missing` symbol resolves to. */
export const MAX_SYMBOL_CHUNKS = 20;
const MAC_DOMAIN = "feedback";
const DAY_MS = 86_400_000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export type FeedbackSource = { kind: "user" } | { kind: "agent"; name: string };

export interface FeedbackChunkRef {
  chunkId: string;
  /**
   * Fingerprint (64 lowercase hex) of the content the observation was about: the chunk as the run showed it. Chunk
   * ids are not content-addressed, so this is what lets a reader tell whether the code is still the same.
   */
  fingerprint: string;
  /**
   * Whether the chunk's current content was identical to the content of the run when the feedback was given. False
   * means the chunk changed (or is gone) since the run, so the observation may describe other code.
   */
  current: boolean;
}

/** A current chunk a `--missing` symbol resolved to, with the fingerprint of its content at that time. */
export interface SymbolChunkRef {
  chunkId: string;
  fingerprint: string;
}

export type FeedbackMissing =
  { path: string; startLine?: number; endLine?: number } | { symbol: string; chunks: SymbolChunkRef[] };

export interface FeedbackRecord {
  recordVersion: 2;
  /** `<time as 13 digits>-<8 hex>`, the document name without its prefix. */
  feedbackId: string;
  /** The run the feedback is about (its history record id). */
  runId: string;
  /** Milliseconds since the epoch when the feedback was recorded. */
  time: number;
  source: FeedbackSource;
  useful: FeedbackChunkRef[];
  irrelevant: FeedbackChunkRef[];
  missing: FeedbackMissing[];
}

interface FeedbackDocument {
  record: FeedbackRecord;
  /** HMAC of the record and the repository root under the user's integrity key. */
  mac: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const isEntry = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_FEEDBACK_ENTRY_CHARS;
const isLine = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const list = (value: unknown, max: number, check: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= max && value.every(check);

const isFingerprint = (value: unknown): value is string => typeof value === "string" && KEY_PATTERN.test(value);

const isChunkRef = (value: unknown): value is FeedbackChunkRef =>
  isObject(value) &&
  onlyKeys(value, ["chunkId", "fingerprint", "current"]) &&
  isEntry(value.chunkId) &&
  isFingerprint(value.fingerprint) &&
  typeof value.current === "boolean";

const isSymbolChunk = (value: unknown): value is SymbolChunkRef =>
  isObject(value) &&
  onlyKeys(value, ["chunkId", "fingerprint"]) &&
  isEntry(value.chunkId) &&
  isFingerprint(value.fingerprint);

function isMissing(value: unknown): value is FeedbackMissing {
  if (!isObject(value)) return false;
  if ("symbol" in value) {
    return (
      onlyKeys(value, ["symbol", "chunks"]) &&
      isEntry(value.symbol) &&
      list(value.chunks, MAX_SYMBOL_CHUNKS, isSymbolChunk) &&
      (value.chunks as unknown[]).length > 0
    );
  }
  if (!onlyKeys(value, ["path", "startLine", "endLine"]) || !isEntry(value.path)) return false;
  // A range has both ends or neither.
  if (value.startLine === undefined || value.endLine === undefined) {
    return value.startLine === undefined && value.endLine === undefined;
  }
  return isLine(value.startLine) && isLine(value.endLine) && value.startLine <= value.endLine;
}

/** An agent name: 1 to 100 characters, no control, format or line-separator characters, not blank. */
export function isAgentName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_AGENT_NAME_CHARS &&
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

const isSource = (value: unknown): value is FeedbackSource =>
  isObject(value) &&
  ((value.kind === "user" && onlyKeys(value, ["kind"])) ||
    (value.kind === "agent" && onlyKeys(value, ["kind", "name"]) && isAgentName(value.name)));

/** Shape check of a record. A record that fails is ignored by readers. */
export function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  return (
    isObject(value) &&
    onlyKeys(value, ["recordVersion", "feedbackId", "runId", "time", "source", "useful", "irrelevant", "missing"]) &&
    value.recordVersion === FEEDBACK_RECORD_VERSION &&
    typeof value.feedbackId === "string" &&
    isRunId(value.feedbackId) &&
    typeof value.runId === "string" &&
    isRunId(value.runId) &&
    typeof value.time === "number" &&
    Number.isInteger(value.time) &&
    value.time >= 0 &&
    isSource(value.source) &&
    list(value.useful, MAX_FEEDBACK_ENTRIES, isChunkRef) &&
    list(value.irrelevant, MAX_FEEDBACK_ENTRIES, isChunkRef) &&
    list(value.missing, MAX_FEEDBACK_ENTRIES, isMissing)
  );
}

const isFeedbackDocument = (payload: unknown): payload is FeedbackDocument =>
  isObject(payload) &&
  onlyKeys(payload, ["record", "mac"]) &&
  typeof payload.mac === "string" &&
  KEY_PATTERN.test(payload.mac) &&
  isFeedbackRecord(payload.record);

const feedbackType = (name: string): DocumentType<FeedbackDocument> => ({
  name,
  schemaVersion: 1,
  validate: isFeedbackDocument,
});

/** A time-sortable, unique feedback id; the same shape as a run id. */
export const newFeedbackId = (time: number): string => newRunId(time);

/** The MAC of a record, bound to the repository's real root, so feedback copied from another repository never verifies. */
export const feedbackMac = (cache: RepositoryCache, record: FeedbackRecord) =>
  recordMac(cache.integrityKey, MAC_DOMAIN, { root: cache.root, record });

/** Whether a read document is a record this user signed for this repository, under the name it was written with. */
const isVerified = (cache: RepositoryCache, name: string, document: FeedbackDocument | undefined) =>
  document !== undefined &&
  `${FEEDBACK_PREFIX}${document.record.feedbackId}` === name &&
  macEquals(document.mac, feedbackMac(cache, document.record));

/** The time encoded in a document name, or undefined when the name is not one Scope wrote. */
function nameTime(name: string): number | undefined {
  if (!name.startsWith(FEEDBACK_PREFIX) || !isRunId(name.slice(FEEDBACK_PREFIX.length))) return undefined;
  return Number(name.slice(FEEDBACK_PREFIX.length, FEEDBACK_PREFIX.length + 13));
}

/** Whether feedback is kept at all under these bounds. */
export function feedbackEnabled(env?: NodeJS.ProcessEnv): boolean {
  const { max, maxDays } = resolveRetention(env).bounds.feedback;
  return max > 0 && maxDays > 0;
}

export type FeedbackOutcome = CommitOutcome & { recorded?: boolean };

/**
 * Writes one feedback record and prunes the feedback, in one commit. The bounds come from `env`: the newest `max`
 * records survive and none older than `maxDays`. With either at 0 nothing is written and all feedback is removed.
 * Pruning goes by the time in the document name; a document takes a retention slot only once verified, and a
 * `feedback-*` name that does not parse or does not verify is removed, so a planted name never evicts real feedback.
 * `recorded` is false when the commit succeeded but the record did not survive the bounds. Never throws.
 */
export async function recordFeedback(
  cache: RepositoryCache,
  record: FeedbackRecord,
  options: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<FeedbackOutcome> {
  try {
    const { max, maxDays } = resolveRetention(options.env).bounds.feedback;
    const enabled = max > 0 && maxDays > 0;
    const now = options.now ?? record.time;
    const name = `${FEEDBACK_PREFIX}${record.feedbackId}`;
    let recorded = false;
    const outcome = await commitRepositoryCache(
      cache,
      async (tx) => {
        const all = new Set((await tx.list()).filter((candidate) => candidate.startsWith(FEEDBACK_PREFIX)));
        if (enabled) all.add(name);
        const recent: string[] = [];
        for (const candidate of all) {
          const time = nameTime(candidate);
          const kept =
            enabled &&
            time !== undefined &&
            time >= now - maxDays * DAY_MS &&
            (candidate === name || isVerified(cache, candidate, await tx.read(feedbackType(candidate))));
          if (kept) recent.push(candidate);
          else if (candidate !== name) tx.removeName(candidate);
        }
        // Names sort by time, so the newest come first once reversed.
        const keep = recent.sort().reverse().slice(0, max);
        for (const candidate of recent) if (!keep.includes(candidate) && candidate !== name) tx.removeName(candidate);
        if (enabled && keep.includes(name)) {
          tx.write(feedbackType(name), { record, mac: feedbackMac(cache, record) });
          recorded = true;
        }
      },
      { now },
    );
    return outcome.committed ? { ...outcome, recorded } : outcome;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    return { committed: false, warning: message };
  }
}

/**
 * The verified feedback records of a repository, newest first (for #77). A document is skipped (never an error) when
 * it is unreadable, fails validation, was not signed under this user's integrity key for this repository, or its id
 * differs from its name, so a planted or cloned `.scope/` contributes nothing. `warnings` describe what was skipped.
 */
export async function readFeedback(cache: RepositoryCache): Promise<{ records: FeedbackRecord[]; warnings: string[] }> {
  const records: FeedbackRecord[] = [];
  const warnings: string[] = [];
  let names: string[];
  try {
    names = (await readdir(cache.directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((name) => {
        if (!name.startsWith(FEEDBACK_PREFIX)) return false;
        if (nameTime(name) !== undefined) return true;
        warnings.push(`${name}.json: not a feedback document Scope wrote; ignoring it`);
        return false;
      })
      .sort()
      .reverse();
  } catch {
    return { records, warnings };
  }
  for (const name of names) {
    const { value, warning } = await cache.store.read(feedbackType(name));
    if (warning) warnings.push(warning);
    else if (!value) continue;
    else if (!isVerified(cache, name, value)) warnings.push(`${name}.json: not signed by this user; ignoring it`);
    else records.push(value.record);
  }
  records.sort((a, b) => (a.feedbackId < b.feedbackId ? 1 : a.feedbackId > b.feedbackId ? -1 : 0));
  return { records, warnings };
}
