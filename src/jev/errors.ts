/** Jev (or a provider) answered, but the answer cannot be trusted. Never recovered silently. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}
