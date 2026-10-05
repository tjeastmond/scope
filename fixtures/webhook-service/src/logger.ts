export class Logger {
  constructor(private readonly prefix: string) {}

  info(message: string): void {
    console.log(`[${this.prefix}] ${message}`);
  }

  warn(message: string, detail?: unknown): void {
    console.warn(`[${this.prefix}] ${message}`, detail ?? "");
  }

  error(message: string, error: unknown): void {
    console.error(`[${this.prefix}] ${message}`, error);
  }
}

export const logger = new Logger("webhook-service");
