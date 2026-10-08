import { createHash, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { JEV_QUESTION_VERSION } from "../config.ts";
import { jevModel } from "../jev/provider.ts";
import { redactSecrets } from "../repository/redact.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../retrieval/config.ts";
import { extractTaskTerms } from "../retrieval/terms.ts";
import type { ChunkKind, CodeChunk, JevMetrics, ScopeResult } from "../types.ts";
import { macEquals, recordMac } from "./integrity.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import { resolveRetention } from "./retention.ts";
import type { CommitOutcome, DocumentType } from "./store.ts";
import { sdkVersion } from "./versions.ts";

/**
 * Run history (#73): one signed document per Jev run, `history-<runId>`. A run records when the cache is on, the mode is
 * `jev` and Jev judged candidates. `--no-jev` runs and runs with no candidates record nothing: they hold no Jev
 * judgment to learn from, and diagnostic baselines would evict real history from the bounded store.
 *
 * A record holds ids, paths, names, fingerprints, numbers and the redacted task. Never source code, raw Jev
 * responses, environment variables or keys.
 */

export const HISTORY_PREFIX = "history-";
/** Version of the record shape; a record of another version is ignored. */
export const HISTORY_RECORD_VERSION = 1;
/** The task text is stored redacted and cut to this many characters. */
export const MAX_TASK_CHARS = 4000;
/** Each term array and each term is bounded. */
export const MAX_TERMS = 200;
export const MAX_TERM_CHARS = 200;
/** More than the shortlist (30) plus supports and skipped entries of any real run. Selected chunks come first. */
export const MAX_HISTORY_CANDIDATES = 1000;
const MAC_DOMAIN = "history";
const DAY_MS = 86_400_000;
/** `<time as 13 decimal digits>-<8 hex>`: sorts by time, unique per run. */
const RUN_ID = /^[0-9]{13}-[0-9a-f]{8}$/;
/** Whether `value` has the shape of a run id (also the shape of a feedback id). */
export const isRunId = (value: string): boolean => RUN_ID.test(value);
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export interface HistoryCandidate {
  chunkId: string;
  file: string;
  kind: ChunkKind;
  name?: string;
  /** SHA-256 hex of the chunk content Scope analyzed (already redacted). The content itself is not stored. */
  fingerprint: string;
  /** `direct` or `expanded-from:<id>`, as in `SelectedChunk.origin`. */
  origin?: string;
  /** Validated Jev relevance; absent for a support chunk Jev never judged. */
  relevance?: number;
  decision: "selected" | "support" | "skipped";
  supportFor?: string[];
}

export interface HistoryRecord {
  recordVersion: 1;
  runId: string;
  /** Milliseconds since the epoch when the run finished (when the record was made). */
  time: number;
  task: { text: string; truncated: boolean; terms: { exact: string[]; words: string[]; variants: string[] } };
  mode: "jev";
  config: {
    scopeVersion: string;
    sdkVersion: string;
    model: string;
    questionVersion: string;
    retrievalConfigVersion: string;
  };
  request: { latencyMs?: number; requestCount?: number; inputTokens?: number; outputTokens?: number };
  candidates: HistoryCandidate[];
}

interface HistoryDocument {
  record: HistoryRecord;
  /** HMAC of the record under the user's integrity key. */
  mac: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isStringArray = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every(isString);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const optional = (value: unknown, check: (item: unknown) => boolean) => value === undefined || check(value);

const CHUNK_KINDS: ReadonlySet<string> = new Set<ChunkKind>([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "component",
  "query",
  "table",
  "style",
  "template",
  "config",
  "section",
  "file",
]);

const isCandidate = (value: unknown): value is HistoryCandidate =>
  isObject(value) &&
  onlyKeys(value, [
    "chunkId",
    "file",
    "kind",
    "name",
    "fingerprint",
    "origin",
    "relevance",
    "decision",
    "supportFor",
  ]) &&
  isString(value.chunkId) &&
  isString(value.file) &&
  isString(value.kind) &&
  CHUNK_KINDS.has(value.kind) &&
  optional(value.name, isString) &&
  isString(value.fingerprint) &&
  KEY_PATTERN.test(value.fingerprint) &&
  optional(value.origin, isString) &&
  optional(value.relevance, (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
  (value.decision === "selected" || value.decision === "support" || value.decision === "skipped") &&
  optional(value.supportFor, (ids) => isStringArray(ids, MAX_HISTORY_CANDIDATES));

/** Shape check of a record. A record that fails is ignored by readers. */
export function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["recordVersion", "runId", "time", "task", "mode", "config", "request", "candidates"])
  ) {
    return false;
  }
  const { task, config, request } = value;
  return (
    value.recordVersion === HISTORY_RECORD_VERSION &&
    isString(value.runId) &&
    RUN_ID.test(value.runId) &&
    isCount(value.time) &&
    value.mode === "jev" &&
    isObject(task) &&
    onlyKeys(task, ["text", "truncated", "terms"]) &&
    isString(task.text) &&
    task.text.length <= MAX_TASK_CHARS &&
    typeof task.truncated === "boolean" &&
    isObject(task.terms) &&
    onlyKeys(task.terms, ["exact", "words", "variants"]) &&
    isStringArray(task.terms.exact, MAX_TERMS) &&
    isStringArray(task.terms.words, MAX_TERMS) &&
    isStringArray(task.terms.variants, MAX_TERMS) &&
    isObject(config) &&
    onlyKeys(config, ["scopeVersion", "sdkVersion", "model", "questionVersion", "retrievalConfigVersion"]) &&
    isString(config.scopeVersion) &&
    isString(config.sdkVersion) &&
    isString(config.model) &&
    isString(config.questionVersion) &&
    isString(config.retrievalConfigVersion) &&
    isObject(request) &&
    onlyKeys(request, ["latencyMs", "requestCount", "inputTokens", "outputTokens"]) &&
    optional(request.latencyMs, isCount) &&
    optional(request.requestCount, isCount) &&
    optional(request.inputTokens, isCount) &&
    optional(request.outputTokens, isCount) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= MAX_HISTORY_CANDIDATES &&
    value.candidates.every(isCandidate)
  );
}

const isHistoryDocument = (payload: unknown): payload is HistoryDocument =>
  isObject(payload) &&
  onlyKeys(payload, ["record", "mac"]) &&
  isString(payload.mac) &&
  KEY_PATTERN.test(payload.mac) &&
  isHistoryRecord(payload.record);

export const historyType = (name: string): DocumentType<HistoryDocument> => ({
  name,
  schemaVersion: 1,
  validate: isHistoryDocument,
});

/**
 * Text with credential shapes redacted, and the configured Jev key removed by value too: its shape is not one the
 * pattern redactor knows, and text pasted with it must not persist it. Short values are skipped so a stray variable
 * cannot blank ordinary words. Used for the stored task and to refuse a credential as a feedback agent name (#76).
 */
export function redactCredentials(text: string): string {
  const redacted = redactSecrets(text);
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key && key.length >= 8 ? redacted.split(key).join("[REDACTED]") : redacted;
}

const withRelevance = (relevance: number | undefined) => (relevance === undefined ? {} : { relevance });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The fingerprint of a chunk's content: SHA-256 hex of the analyzed (already redacted) text. History records it per
 * candidate and feedback (#77) per observation, so both can be checked against the current source: a chunk id alone
 * does not prove the code is unchanged.
 */
export const contentFingerprint = (content: string): string => sha256(content);

/** A time-sortable, unique run id: the time as 13 zero-padded decimal digits, then 8 random hex characters. */
export function newRunId(time: number): string {
  return `${String(Math.min(Math.max(Math.trunc(time), 0), 9_999_999_999_999)).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
}

/**
 * The MAC of a record, bound to the repository's real root: a record signed for another repository of the same user
 * (copied, or the store of a moved repository) never verifies here.
 */
export const historyMac = (cache: RepositoryCache, record: HistoryRecord) =>
  recordMac(cache.integrityKey, MAC_DOMAIN, { root: cache.root, record });

/** Whether a read document is a record this user signed for this repository, under the name it was written with. */
const isVerified = (cache: RepositoryCache, name: string, document: HistoryDocument | undefined) =>
  document !== undefined &&
  `${HISTORY_PREFIX}${document.record.runId}` === name &&
  macEquals(document.mac, historyMac(cache, document.record));

/** The time encoded in a document name, or undefined when the name is not one Scope wrote. */
function nameTime(name: string): number | undefined {
  if (!name.startsWith(HISTORY_PREFIX) || !RUN_ID.test(name.slice(HISTORY_PREFIX.length))) return undefined;
  return Number(name.slice(HISTORY_PREFIX.length, HISTORY_PREFIX.length + 13));
}

/** A commit outcome that also names the run id when the run's record was written. */
export type HistoryOutcome = CommitOutcome & { runId?: string };

export interface RecordInput {
  /** The task as given; redacted here. */
  task: string;
  result: ScopeResult;
  /** Every chunk of the repository by id (to find kind and content of skipped candidates). */
  chunks: ReadonlyMap<string, CodeChunk>;
  /** Validated Jev relevance by chunk id: a support that Jev judged below the minimum keeps its judgment. */
  relevance: ReadonlyMap<string, number>;
  jev?: JevMetrics;
  time: number;
  /** The retrieval config version the run used, adaptive suffix included (#78); default: the baseline's. */
  retrievalConfigVersion?: string;
}

/** Builds the record of a run. Pure apart from the random part of the run id and reading the installed versions. */
export async function buildHistoryRecord(input: RecordInput, versions: { scope: string }): Promise<HistoryRecord> {
  const { result, chunks, jev, time } = input;
  const redacted = redactCredentials(input.task);
  const terms = extractTaskTerms(redacted);
  const cap = (list: string[]) => list.slice(0, MAX_TERMS).map((term) => term.slice(0, MAX_TERM_CHARS));
  const candidates: HistoryCandidate[] = [];
  for (const selected of result.chunks) {
    const { chunk } = selected;
    candidates.push({
      chunkId: chunk.id,
      file: chunk.file,
      kind: chunk.kind,
      ...(chunk.name === undefined ? {} : { name: chunk.name }),
      fingerprint: contentFingerprint(chunk.content),
      ...(selected.origin === undefined ? {} : { origin: selected.origin }),
      ...withRelevance(selected.relevance ?? input.relevance.get(chunk.id)),
      decision: selected.supportFor === undefined ? "selected" : "support",
      ...(selected.supportFor === undefined ? {} : { supportFor: [...selected.supportFor] }),
    });
  }
  for (const skipped of result.skipped) {
    const chunk = chunks.get(skipped.chunkId);
    if (!chunk) continue;
    candidates.push({
      chunkId: chunk.id,
      file: chunk.file,
      kind: chunk.kind,
      ...(chunk.name === undefined ? {} : { name: chunk.name }),
      fingerprint: contentFingerprint(chunk.content),
      ...(skipped.relevance === undefined ? {} : { relevance: skipped.relevance }),
      decision: "skipped",
    });
  }
  return {
    recordVersion: HISTORY_RECORD_VERSION,
    runId: newRunId(time),
    time,
    task: {
      text: redacted.slice(0, MAX_TASK_CHARS),
      truncated: redacted.length > MAX_TASK_CHARS,
      terms: { exact: cap(terms.exact), words: cap(terms.words), variants: cap(terms.variants) },
    },
    mode: "jev",
    config: {
      scopeVersion: versions.scope,
      sdkVersion: await sdkVersion(),
      model: jevModel(),
      questionVersion: JEV_QUESTION_VERSION,
      retrievalConfigVersion: input.retrievalConfigVersion ?? DEFAULT_RETRIEVAL_CONFIG.version,
    },
    request: {
      ...(jev === undefined ? {} : { latencyMs: jev.latencyMs }),
      ...(jev?.requestCount === undefined ? {} : { requestCount: jev.requestCount }),
      ...(jev === undefined ? {} : { inputTokens: jev.usage.inputTokens, outputTokens: jev.usage.outputTokens }),
    },
    candidates: candidates.slice(0, MAX_HISTORY_CANDIDATES),
  };
}

/**
 * Writes the record of a run and prunes the history, in one commit. The bounds come from `env`: the newest `maxRuns`
 * records survive and none older than `maxDays`. With either at 0 nothing is written and all history is removed.
 * Pruning goes by the time in the document name, without reading the documents; a `history-*` name that does not
 * parse is not one Scope wrote and is removed. Never throws: a failure comes back as `committed: false`.
 */
export async function recordHistory(
  cache: RepositoryCache,
  input: RecordInput,
  options: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<HistoryOutcome> {
  try {
    const { bounds } = resolveRetention(options.env);
    const { maxRuns, maxDays } = bounds.history;
    let written: string | undefined;
    const enabled = maxRuns > 0 && maxDays > 0;
    const record = enabled ? await buildHistoryRecord(input, { scope: cache.keys.scope }) : undefined;
    const now = options.now ?? input.time;
    const outcome = await commitRepositoryCache(
      cache,
      async (tx) => {
        const name = record ? `${HISTORY_PREFIX}${record.runId}` : undefined;
        const existing = (await tx.list()).filter((candidate) => candidate.startsWith(HISTORY_PREFIX));
        const all = new Set(existing);
        if (name) all.add(name);
        const recent: string[] = [];
        for (const candidate of all) {
          const time = nameTime(candidate);
          // A document takes a retention slot only once verified, so a planted name (a far-future time, say) can never
          // evict real history or keep new runs out.
          const kept =
            enabled &&
            time !== undefined &&
            time >= now - maxDays * DAY_MS &&
            (candidate === name || isVerified(cache, candidate, await tx.read(historyType(candidate))));
          if (kept) recent.push(candidate);
          else if (candidate !== name) tx.removeName(candidate);
        }
        // Names sort by time, so the newest come first once reversed.
        const keep = recent.sort().reverse().slice(0, maxRuns);
        for (const candidate of recent) if (!keep.includes(candidate) && candidate !== name) tx.removeName(candidate);
        if (record && name && keep.includes(name)) {
          tx.write(historyType(name), {
            record,
            mac: historyMac(cache, record),
          });
          written = record.runId;
        }
      },
      { now },
    );
    return outcome.committed && written !== undefined ? { ...outcome, runId: written } : outcome;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    return { committed: false, warning: message };
  }
}

/**
 * The verified record of one run, or undefined for any reason it cannot be trusted: a malformed id, no such document,
 * unreadable, failing validation, not signed by this user for this repository. Never throws.
 */
export async function readHistoryRecord(cache: RepositoryCache, runId: string): Promise<HistoryRecord | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const name = `${HISTORY_PREFIX}${runId}`;
  try {
    const { value } = await cache.store.read(historyType(name));
    return isVerified(cache, name, value) ? value!.record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The verified records of a repository's history, newest first. A document is skipped (never an error) when it is
 * unreadable, fails validation, was not signed under this user's integrity key, or its record id differs from its name,
 * so a planted or cloned `.scope/` contributes nothing. `warnings` describe what was skipped.
 */
export async function readHistory(cache: RepositoryCache): Promise<{ records: HistoryRecord[]; warnings: string[] }> {
  const records: HistoryRecord[] = [];
  const warnings: string[] = [];
  let names: string[];
  try {
    names = (await readdir(cache.directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((name) => {
        if (!name.startsWith(HISTORY_PREFIX)) return false;
        if (nameTime(name) !== undefined) return true;
        warnings.push(`${name}.json: not a history document Scope wrote; ignoring it`);
        return false;
      })
      .sort()
      .reverse();
  } catch {
    return { records, warnings };
  }
  for (const name of names) {
    const { value, warning } = await cache.store.read(historyType(name));
    if (warning) warnings.push(warning);
    else if (!value) continue;
    else if (!isVerified(cache, name, value)) {
      warnings.push(`${name}.json: not signed by this user; ignoring it`);
    } else records.push(value.record);
  }
  records.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return { records, warnings };
}
