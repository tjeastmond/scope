/** Jev (or a provider) answered, but the answer cannot be trusted. Never recovered silently. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

/** Jev could not be reached or did not complete (credentials, network, timeout, HTTP error). */
export class JevUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JevUnavailableError";
  }
}

/** The request Scope would send cannot fit Jev's limits, so it was not sent. */
export class JevRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}
