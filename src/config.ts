/** Maximum candidates sent to Jev per run (plan target: 20-30 chunks). */
export const MAX_CANDIDATES = 30;

/** Estimated tokens per Jev request; well under the documented 32k state-plus-question and 64k request limits. */
export const JEV_BATCH_TOKEN_BUDGET = 24_000;

/** Overall deadline for judging all candidates; the SDK only bounds each attempt. */
export const JEV_DEADLINE_MS = 90_000;

/** Per-attempt SDK timeout. */
export const JEV_ATTEMPT_TIMEOUT_MS = 30_000;

/** Candidates scoring below this are never selected. */
export const MIN_RELEVANCE = 0.5;

/** Default output budget in estimated tokens. */
export const DEFAULT_BUDGET = 8000;

/** Files larger than this are skipped (`too-large`) and never read or sent. */
export const MAX_FILE_BYTES = 1_000_000;

/** The scan stops after this many eligible files and warns. */
export const MAX_SCAN_FILES = 10_000;

/** Directories nested deeper than this (the root is depth 0) are not entered; the scan warns. */
export const MAX_SCAN_DEPTH = 32;

/** The scan stops once the eligible files total this many bytes and warns. */
export const MAX_SCAN_BYTES = 50_000_000;
