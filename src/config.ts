/** Maximum candidates sent to Jev per run (plan target: 20-30 chunks). */
export const MAX_CANDIDATES = 30;

/** Estimated tokens per Jev request; well under the documented 32k state-plus-question and 64k request limits. */
export const JEV_BATCH_TOKEN_BUDGET = 24_000;

/** Overall deadline for judging all candidates; the SDK only bounds each attempt. */
export const JEV_DEADLINE_MS = 90_000;

/** Per-attempt SDK timeout. */
export const JEV_ATTEMPT_TIMEOUT_MS = 30_000;
