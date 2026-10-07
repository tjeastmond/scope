import { CancelledError, UsageError } from "./errors.ts";
import {
  JevAuthError,
  JevCancelledError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevServiceError,
  JevTimeoutError,
  JevUnavailableError,
} from "./jev/errors.ts";

/** The process exit code of every outcome. Each Jev failure class has its own, so a script can tell them apart. */
export const EXIT_CODES = Object.freeze({
  success: 0,
  /** Any other failure: output errors, unexpected errors. */
  failure: 1,
  usage: 2,
  /** TYPESAFE_API_KEY missing or rejected (HTTP 401/403). */
  jevAuth: 3,
  jevRateLimit: 4,
  jevTimeout: 5,
  /** Jev failed or could not be reached (5xx, network), or another unavailable condition. */
  jevService: 6,
  /** Jev answered, but the answer is unusable. */
  jevResponse: 7,
  /** The request cannot fit Jev's limits. */
  jevRequest: 8,
  /** Ctrl-C: 128 + SIGINT (2), the shell convention. */
  cancelled: 130,
});

/** Maps a failure to its exit code. The most specific classes come first: the Jev ones extend JevUnavailableError. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CancelledError || error instanceof JevCancelledError) return EXIT_CODES.cancelled;
  if (error instanceof UsageError) return EXIT_CODES.usage;
  if (error instanceof JevAuthError) return EXIT_CODES.jevAuth;
  if (error instanceof JevRateLimitError) return EXIT_CODES.jevRateLimit;
  if (error instanceof JevTimeoutError) return EXIT_CODES.jevTimeout;
  if (error instanceof JevServiceError || error instanceof JevUnavailableError) return EXIT_CODES.jevService;
  if (error instanceof JevResponseError) return EXIT_CODES.jevResponse;
  if (error instanceof JevRequestError) return EXIT_CODES.jevRequest;
  return EXIT_CODES.failure;
}
