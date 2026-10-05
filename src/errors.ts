/** A problem with how Scope was invoked (bad path, bad budget), as opposed to a failure while running. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
