import { DEFAULT_RETRIEVAL_CONFIG } from "./retrieval/config.ts";

/** Maximum candidates sent to Jev per run (plan target: 20-30 chunks); the retrieval configuration owns the value. */
export const MAX_CANDIDATES = DEFAULT_RETRIEVAL_CONFIG.shortlistSize;

/**
 * Serialized characters per Jev request (task, metadata, source and questions). A conservative batching size, not a
 * token guarantee: ordinary code is well under one token per character, and the documented limit is 32k tokens
 * state-plus-question, so requests stay far below it at the cost of more of them.
 */
export const JEV_BATCH_MAX_CHARS = 24_000;

/**
 * Questions (candidates) per Jev request. The API documents no per-request question limit; this is a conservative cap
 * that keeps each request's latency, and any retry of it, small. A request closes at this count or at
 * JEV_BATCH_MAX_CHARS, whichever comes first.
 */
export const JEV_BATCH_MAX_QUESTIONS = 16;

/** Jev requests in flight at once; well under the documented rate limit of 80 requests per second. */
export const JEV_CONCURRENCY = 4;

/**
 * Characters of one candidate's code sent to Jev for judging: a quarter of the batch cap, so one candidate plus a
 * normal task always fits. Judging only; the selected artifact still carries the full chunk.
 */
export const JEV_CANDIDATE_MAX_CHARS = 6_000;

/**
 * Identifies the exact question text and criteria sent to Jev. Change it whenever either changes, because cached
 * decisions (M6) are only reusable under the same version.
 */
export const JEV_QUESTION_VERSION = "relevance-v1";

/**
 * Overall deadline for judging all candidates: the Jev phase of a run never takes longer, even if a request ignores
 * cancellation. The SDK bounds only each attempt and has no total retry budget. Without this deadline the worst case
 * would be ceil(batches / JEV_CONCURRENCY) rounds of one batch's worst case, which is (JEV_MAX_RETRIES + 1) attempts x
 * JEV_ATTEMPT_TIMEOUT_MS plus JEV_MAX_RETRIES waits of at most JEV_MAX_RETRY_AFTER_MS: 3 x 30 s + 2 x 10 s = 110 s per
 * round. So this deadline, not the retries, is the bound. Measured attempts take well under a second
 * (docs/jev-sdk-notes.md).
 */
export const JEV_DEADLINE_MS = 90_000;

/** Per-attempt SDK timeout, covering the full response. */
export const JEV_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * SDK retries after the first attempt, for HTTP 408, 429 and 5xx, connection errors and attempt timeouts. Scope adds
 * no retry loop of its own.
 */
export const JEV_MAX_RETRIES = 2;

/**
 * Longest server-requested `Retry-After` the SDK waits before a retry (the SDK default is 60 s). A longer request falls
 * back to the SDK's backoff of 0.5 s doubling to at most 5 s.
 */
export const JEV_MAX_RETRY_AFTER_MS = 10_000;

/** Candidates scoring below this are never selected. */
export const MIN_RELEVANCE = 0.5;

/** Files larger than this are skipped (`too-large`) and never read or sent. */
export const MAX_FILE_BYTES = 1_000_000;

/** The scan stops after this many eligible files and warns. */
export const MAX_SCAN_FILES = 10_000;

/** Directories nested deeper than this (the root is depth 0) are not entered; the scan warns. */
export const MAX_SCAN_DEPTH = 32;

/** The scan stops once the eligible files total this many bytes and warns. */
export const MAX_SCAN_BYTES = 50_000_000;
