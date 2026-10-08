import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import {
  FEEDBACK_RECORD_VERSION,
  MAX_AGENT_NAME_CHARS,
  MAX_FEEDBACK_ENTRIES,
  MAX_FEEDBACK_ENTRY_CHARS,
  MAX_SYMBOL_CHUNKS,
  feedbackEnabled,
  isAgentName,
  newFeedbackId,
  recordFeedback,
  type FeedbackChunkRef,
  type FeedbackMissing,
  type FeedbackRecord,
  type FeedbackSource,
} from "./cache/feedback.ts";
import { CacheControlError } from "./cache/controls.ts";
import { isRunId, readHistoryRecord, redactCredentials } from "./cache/history.ts";
import { openRepositoryCache } from "./cache/location.ts";
import { resolveRetention } from "./cache/retention.ts";
import type { VersionKeys } from "./cache/versions.ts";
import { CancelledError, UsageError } from "./errors.ts";
import { resolveRepository } from "./repository/root.ts";
import { loadChunks } from "./scope.ts";
import type { CodeChunk } from "./types.ts";

/**
 * `scope feedback` (#76): records an attributed observation about the chunks one earlier run selected. Everything is
 * validated before anything is written, so a submission is recorded whole or not at all. Feedback never changes a
 * selection, a score, decision reuse or any output of a run; it is only recorded (and counted by `scope cache status`).
 */

/** The keys of a `--file` document, and the shape of a submission before validation. */
export interface FeedbackInput {
  runId?: string;
  useful: string[];
  irrelevant: string[];
  missing: string[];
  agent?: string;
}

export interface FeedbackResult {
  feedbackId: string;
  runId: string;
  time: number;
  source: FeedbackSource;
  counts: { useful: number; irrelevant: number; missing: number };
  /** Non-fatal findings, for example a chunk that changed since the run. */
  warnings: string[];
}

/** A `--file` document larger than this is refused before it is parsed. */
export const MAX_FEEDBACK_FILE_BYTES = 1_000_000;
const FILE_KEYS = ["runId", "useful", "irrelevant", "missing", "agent"] as const;
const LISTS = ["useful", "irrelevant", "missing"] as const;
/** Cap on ids named in one error message. */
const NAMED = 10;
const RANGE = /^(.+):([0-9]{1,9})-([0-9]{1,9})$/;
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Parses the JSON document given with `--file`: `{ runId?, useful?, irrelevant?, missing?, agent? }`. Strict: anything
 * else (a non-object, an unknown key, a wrong type) is a usage error.
 */
export function parseFeedbackFile(text: string, label: string): FeedbackInput {
  if (Buffer.byteLength(text, "utf8") > MAX_FEEDBACK_FILE_BYTES) {
    throw new UsageError(`${label} is larger than ${MAX_FEEDBACK_FILE_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${label} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${label} must hold a JSON object with the keys ${FILE_KEYS.join(", ")}.`);
  }
  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`${label}: unknown key "${key.slice(0, 50)}". Allowed keys: ${FILE_KEYS.join(", ")}.`);
    }
  }
  const input: FeedbackInput = { useful: [], irrelevant: [], missing: [] };
  for (const key of LISTS) {
    const value = object[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new UsageError(`${label}: "${key}" must be an array of strings.`);
    }
    input[key] = value as string[];
  }
  for (const key of ["runId", "agent"] as const) {
    const value = object[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new UsageError(`${label}: "${key}" must be a string.`);
    input[key] = value;
  }
  return input;
}

/** Joins the flags and the file: lists are concatenated; a run id or agent given twice must agree. */
export function mergeFeedbackInput(flags: FeedbackInput, file: FeedbackInput | undefined): FeedbackInput {
  if (!file) return flags;
  if (flags.runId !== undefined && file.runId !== undefined && flags.runId !== file.runId) {
    throw new UsageError(
      `The run id in the file (${file.runId.slice(0, 40)}) differs from the one given on the command line.`,
    );
  }
  if (flags.agent !== undefined && file.agent !== undefined && flags.agent !== file.agent) {
    throw new UsageError("The agent name in the file differs from --agent.");
  }
  const runId = flags.runId ?? file.runId;
  const agent = flags.agent ?? file.agent;
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(agent === undefined ? {} : { agent }),
    useful: [...flags.useful, ...file.useful],
    irrelevant: [...flags.irrelevant, ...file.irrelevant],
    missing: [...flags.missing, ...file.missing],
  };
}

const quoted = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}...` : text);
const shown = (items: string[]) =>
  `${items.slice(0, NAMED).map(quoted).join(", ")}${items.length > NAMED ? `, and ${items.length - NAMED} more` : ""}`;

/** Checks one list: printable, bounded entries; duplicates collapsed; the entry count bounded. */
function checkList(name: string, items: readonly string[]): string[] {
  const unique = [...new Set(items)];
  for (const item of unique) {
    if (item.length === 0 || item.trim().length === 0) throw new UsageError(`--${name}: an entry is empty.`);
    if (item.length > MAX_FEEDBACK_ENTRY_CHARS) {
      throw new UsageError(`--${name}: an entry is longer than ${MAX_FEEDBACK_ENTRY_CHARS} characters.`);
    }
    if (UNPRINTABLE.test(item)) throw new UsageError(`--${name}: an entry contains a control character.`);
  }
  if (unique.length > MAX_FEEDBACK_ENTRIES) {
    throw new UsageError(`--${name}: at most ${MAX_FEEDBACK_ENTRIES} entries are allowed; got ${unique.length}.`);
  }
  return unique;
}

interface Validated {
  runId: string;
  useful: string[];
  irrelevant: string[];
  missing: string[];
  source: FeedbackSource;
}

/** Everything that can be checked without touching the repository or the cache. Throws UsageError. */
function validateInput(input: FeedbackInput): Validated {
  if (input.runId === undefined || input.runId === "") {
    throw new UsageError("A run id is required: scope feedback <run-id> ... (the Run line of a Scope result).");
  }
  if (!isRunId(input.runId)) {
    throw new UsageError(`Not a run id: ${quoted(input.runId)}. A run id looks like 1700000000000-0123abcd.`);
  }
  const useful = checkList("useful", input.useful);
  const irrelevant = checkList("irrelevant", input.irrelevant);
  const missing = checkList("missing", input.missing);
  if (useful.length + irrelevant.length + missing.length === 0) {
    throw new UsageError("Nothing to record: give at least one of --useful, --irrelevant or --missing.");
  }
  const both = useful.filter((id) => irrelevant.includes(id));
  if (both.length > 0) {
    throw new UsageError(`A chunk cannot be both useful and irrelevant: ${shown(both)}.`);
  }
  let source: FeedbackSource = { kind: "user" };
  if (input.agent !== undefined) {
    if (!isAgentName(input.agent)) {
      throw new UsageError(
        `--agent must be 1 to ${MAX_AGENT_NAME_CHARS} printable characters without control characters.`,
      );
    }
    // Refused rather than redacted: attribution is stored as given, and the error does not echo the value.
    if (redactCredentials(input.agent) !== input.agent) {
      throw new UsageError("--agent looks like a credential; use a plain agent name.");
    }
    source = { kind: "agent", name: input.agent };
  }
  return { runId: input.runId, useful, irrelevant, missing, source };
}

const lineCount = (text: string): number =>
  text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * Resolves one `--missing` value against the current repository. Classification: a value of the form
 * `path:start-end` is a line range of an included text file; any other value that is an included repository-relative
 * text file path is the whole file (a text file in a language Scope has no analyzer for counts); anything else must be
 * the exact `name` of at least one current chunk (a symbol). A path that is absolute, climbs out of the repository, or
 * is not a text file the scan includes (ignored, binary, secret-like, excluded) is never read and is not a symbol
 * either, so it is rejected.
 */
async function resolveMissing(
  value: string,
  root: string,
  files: ReadonlySet<string>,
  chunks: readonly CodeChunk[],
): Promise<FeedbackMissing> {
  const range = RANGE.exec(value);
  const spelled = range ? range[1]! : value;
  let path: string | undefined;
  if (!isAbsolute(spelled) && !spelled.includes("\\")) {
    const normal = posix.normalize(spelled);
    if (normal !== ".." && !normal.startsWith("../") && !normal.endsWith("/") && files.has(normal)) path = normal;
  }
  if (path !== undefined) {
    if (!range) return { path };
    const startLine = Number(range[2]);
    const endLine = Number(range[3]);
    if (startLine < 1 || startLine > endLine) {
      throw new UsageError(
        `--missing ${quoted(value)}: the range must start at line 1 or later and not end before it starts.`,
      );
    }
    const bytes = await readFile(join(root, path));
    if (bytes.includes(0)) throw new UsageError(`--missing ${quoted(value)}: ${path} is not a text file.`);
    const lines = lineCount(bytes.toString("utf8"));
    if (endLine > lines) throw new UsageError(`--missing ${quoted(value)}: ${path} has only ${lines} lines.`);
    return { path, startLine, endLine };
  }
  if (range) {
    throw new UsageError(
      `--missing ${quoted(value)}: ${quoted(spelled)} is not a file Scope includes. A path must be repository-relative, inside the repository and not ignored, binary or secret-like.`,
    );
  }
  const named = chunks
    .filter((chunk) => chunk.name === value)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine || (a.id < b.id ? -1 : 1)));
  if (named.length === 0) {
    throw new UsageError(
      `--missing ${quoted(value)}: neither a file Scope includes (repository-relative, not ignored, binary or secret-like) nor the name of a chunk in the current source.`,
    );
  }
  return { symbol: value, chunkIds: named.slice(0, MAX_SYMBOL_CHUNKS).map((chunk) => chunk.id) };
}

export interface SubmitOptions {
  /** Repository root (default: current directory). */
  repo?: string;
  signal?: AbortSignal;
  /** Where `SCOPE_CACHE` and the feedback retention bounds are read from (default: the process environment). */
  env?: NodeJS.ProcessEnv;
  /** Test seams, as for `runScope`. */
  cacheOptions?: {
    keys?: VersionKeys;
    integrityEnv?: NodeJS.ProcessEnv;
    now?: () => number;
    racyMarginMs?: number;
    lockWaitMs?: number;
  };
}

/**
 * Validates a submission against the run's history record and the current source, then records it.
 *
 * Errors: a malformed or unverifiable run, an unknown chunk id, an unusable `--missing` value, a bad agent name or any
 * other bad input is a {@link UsageError} (exit 2) and nothing is written. The cache switched off (`SCOPE_CACHE=off`)
 * or feedback switched off by a retention bound of 0 is a UsageError too: it is the user's configuration, like
 * `scope cache rebuild` with the cache off. A cache that cannot be opened or written is a {@link CacheControlError}
 * (exit 1): the input was fine, the environment was not.
 */
export async function submitFeedback(input: FeedbackInput, options: SubmitOptions = {}): Promise<FeedbackResult> {
  const submission = validateInput(input);
  const env = options.env ?? process.env;
  if (env.SCOPE_CACHE === "off") {
    throw new UsageError("scope feedback needs the local cache, and SCOPE_CACHE=off turns it off.");
  }
  const retention = resolveRetention(env);
  if (!feedbackEnabled(env)) {
    throw new UsageError(
      "scope feedback needs the local cache to keep feedback, and SCOPE_FEEDBACK_MAX or SCOPE_FEEDBACK_MAX_DAYS is 0, which turns feedback off.",
    );
  }
  const { root } = resolveRepository(options.repo ?? ".");
  const seams = options.cacheOptions ?? {};
  const opened = await openRepositoryCache(root, {
    keys: seams.keys,
    integrityEnv: seams.integrityEnv,
    lockWaitMs: seams.lockWaitMs,
  });
  const cache = opened.cache;
  if (!cache) {
    throw new CacheControlError(
      `scope feedback needs the local cache, which is not available: ${opened.warnings.join("; ") || "it could not be opened"}.`,
    );
  }
  // Read before the scan below: a scan that finds a stale cache resets it, history included.
  const run = await readHistoryRecord(cache, submission.runId);
  if (!run) {
    throw new UsageError(
      `Unknown run ${submission.runId}: this repository's history has no verified record of it. ` +
        "Only Jev runs with the cache on are recorded, and history is bounded (see scope cache status).",
    );
  }
  const candidates = new Map(run.candidates.map((candidate) => [candidate.chunkId, candidate]));
  for (const list of ["useful", "irrelevant"] as const) {
    const unknown = submission[list].filter((id) => !candidates.has(id));
    if (unknown.length > 0) throw new UsageError(`--${list}: not a candidate of run ${run.runId}: ${shown(unknown)}.`);
  }

  const loaded = await loadChunks(root, {
    signal: options.signal,
    cache: {
      keys: seams.keys,
      integrityEnv: seams.integrityEnv,
      lockWaitMs: seams.lockWaitMs,
      now: seams.now,
      racyMarginMs: seams.racyMarginMs,
    },
  });
  const current = new Map(loaded.chunks.map((chunk) => [chunk.id, chunk]));
  const warnings = [...retention.warnings];
  const refs = (ids: string[]): FeedbackChunkRef[] =>
    ids.map((chunkId) => {
      const found = current.get(chunkId);
      const isCurrent = found !== undefined && sha256(found.content) === candidates.get(chunkId)!.fingerprint;
      if (!isCurrent) warnings.push(`chunk ${chunkId} changed since run ${run.runId}`);
      return { chunkId, current: isCurrent };
    });
  const useful = refs(submission.useful);
  const irrelevant = refs(submission.irrelevant);

  const files = new Set(loaded.files);
  const missing: FeedbackMissing[] = [];
  const seen = new Set<string>();
  for (const value of submission.missing) {
    const entry = await resolveMissing(value, root, files, loaded.chunks);
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(entry);
  }

  const time = seams.now?.() ?? Date.now();
  const record: FeedbackRecord = {
    recordVersion: FEEDBACK_RECORD_VERSION,
    feedbackId: newFeedbackId(time),
    runId: run.runId,
    time,
    source: submission.source,
    useful,
    irrelevant,
    missing,
  };
  if (options.signal?.aborted) throw new CancelledError();
  const outcome = await recordFeedback(cache, record, { env, now: time });
  if (!outcome.committed) throw new CacheControlError(`the feedback could not be written: ${outcome.warning}`);
  if (!outcome.recorded) {
    throw new CacheControlError(
      "the feedback was not kept: newer feedback fills the retention bounds (SCOPE_FEEDBACK_MAX).",
    );
  }
  return {
    feedbackId: record.feedbackId,
    runId: record.runId,
    time,
    source: record.source,
    counts: { useful: useful.length, irrelevant: irrelevant.length, missing: missing.length },
    warnings,
  };
}
