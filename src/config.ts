import { DEFAULT_RETRIEVAL_CONFIG } from "./retrieval/config.ts";

/** Maximum candidates sent to Jev per run (plan target: 20-30 chunks); the retrieval configuration owns the value. */
export const MAX_CANDIDATES = DEFAULT_RETRIEVAL_CONFIG.shortlistSize;

/**
 * Serialized characters per Jev request (task, metadata, source and questions). Sized at one token per character, the
 * worst case for arbitrary Unicode, so a request stays under the documented 32k state-plus-question limit whatever the
 * source contains; ordinary code uses far fewer tokens, at the cost of more requests.
 */
export const JEV_BATCH_MAX_CHARS = 24_000;

/** Overall deadline for judging all candidates; the SDK only bounds each attempt. */
export const JEV_DEADLINE_MS = 90_000;

/** Per-attempt SDK timeout. */
export const JEV_ATTEMPT_TIMEOUT_MS = 30_000;

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
