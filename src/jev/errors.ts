/** Common base of every failure that comes from, or is about, Jev. */
export class JevError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JevError";
  }
}

/** Jev (or a provider) answered, but the answer cannot be trusted. Never recovered silently. */
export class JevResponseError extends JevError {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

/** Jev could not be reached or did not complete (credentials, network, timeout, HTTP error). */
export class JevUnavailableError extends JevError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JevUnavailableError";
  }
}

/** Missing or rejected credentials (no key, HTTP 401 or 403). */
export class JevAuthError extends JevUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JevAuthError";
  }
}

/** Jev asked Scope to slow down (HTTP 429). */
export class JevRateLimitError extends JevUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JevRateLimitError";
  }
}

/** A request attempt or Scope's overall deadline ran out. */
export class JevTimeoutError extends JevUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JevTimeoutError";
  }
}

/** The caller cancelled the run (for example Ctrl-C). */
export class JevCancelledError extends JevUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JevCancelledError";
  }
}

/** Jev failed on its side or could not be reached (5xx, connection errors, any other unexpected failure). */
export class JevServiceError extends JevUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JevServiceError";
  }
}

/** The request Scope would send cannot fit Jev's limits, so it was not sent (or Jev refused it as too large). */
export class JevRequestError extends JevError {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}
