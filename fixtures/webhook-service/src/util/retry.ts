export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function computeBackoff(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * options.baseDelayMs;
  return Math.min(exponential + jitter, options.maxDelayMs);
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < options.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, computeBackoff(attempt, options)));
      }
    }
  }
  throw lastError;
}
