export interface ScopeOptions {
  task: string;
}

/** Orchestrates a Scope run. Callable without argument parsing; `cli.ts` only parses args and calls this. */
export async function runScope(options: ScopeOptions): Promise<string> {
  return `Not implemented yet: ${options.task}\n`;
}
