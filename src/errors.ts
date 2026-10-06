/** A problem with how Scope was invoked (bad path, bad option), as opposed to a failure while running. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** An invalid retrieval configuration (an internal override, never a CLI option); `field` names the bad value. */
export class RetrievalConfigError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid retrieval config: ${field} ${reason}`);
    this.name = "RetrievalConfigError";
  }
}
