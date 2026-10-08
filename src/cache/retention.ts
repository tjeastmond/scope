/** How much of each kind of retained data the cache keeps. 0 keeps none (the data type is disabled). */
export interface RetentionBounds {
  history: { maxRuns: number; maxDays: number };
  decisions: { max: number; maxDays: number };
  feedback: { max: number; maxDays: number };
}

/** The defaults of docs/cache-design.md "Retention bounds". */
export const DEFAULT_RETENTION: Readonly<RetentionBounds> = Object.freeze({
  history: Object.freeze({ maxRuns: 200, maxDays: 90 }),
  decisions: Object.freeze({ max: 500, maxDays: 7 }),
  feedback: Object.freeze({ max: 2000, maxDays: 365 }),
});

/** An override may be at most this many times its default. */
export const RETENTION_CAP_FACTOR = 10;

const VARIABLES = [
  ["SCOPE_HISTORY_MAX_RUNS", "history", "maxRuns"],
  ["SCOPE_HISTORY_MAX_DAYS", "history", "maxDays"],
  ["SCOPE_DECISIONS_MAX", "decisions", "max"],
  ["SCOPE_DECISIONS_MAX_DAYS", "decisions", "maxDays"],
  ["SCOPE_FEEDBACK_MAX", "feedback", "max"],
  ["SCOPE_FEEDBACK_MAX_DAYS", "feedback", "maxDays"],
] as const;

/** Digits only: no sign, exponent, fraction or whitespace. At most 10 digits keeps the number exact. */
const DECIMAL_INTEGER = /^[0-9]{1,10}$/;

/**
 * The retention bounds in effect: the defaults, overridden by the `SCOPE_*` variables above. An invalid or
 * out-of-range value is ignored with a warning that names the variable and the allowed range. Reads only those
 * variables and never echoes the value or any other environment content.
 */
export function resolveRetention(env: NodeJS.ProcessEnv = process.env): {
  bounds: RetentionBounds;
  warnings: string[];
} {
  const bounds: RetentionBounds = structuredClone(DEFAULT_RETENTION) as RetentionBounds;
  const warnings: string[] = [];
  for (const [variable, group, field] of VARIABLES) {
    const raw = env[variable];
    if (raw === undefined) continue;
    const target = bounds[group] as Record<string, number>;
    const fallback = target[field]!;
    const cap = fallback * RETENTION_CAP_FACTOR;
    const value = DECIMAL_INTEGER.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= 0 && value <= cap)) {
      warnings.push(
        `${variable} must be a whole number from 0 to ${cap}; ignoring it and using the default ${fallback}`,
      );
      continue;
    }
    target[field] = value;
  }
  return { bounds, warnings };
}
