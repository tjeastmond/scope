import { parseArgs } from "node:util";
import { DEFAULT_BUDGET } from "./config.ts";
import { renderResult } from "./output/text.ts";
import { runScope, UsageError } from "./scope.ts";
import type { DecisionProvider } from "./types.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--budget <tokens>] [--no-jev]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --budget <tokens>  Estimated token budget (default: ${DEFAULT_BUDGET})
  --no-jev           Skip Jev and use the offline baseline (no credentials or network)
  -h, --help         Show this help

By default Scope sends the task and candidate source code to Jev and needs TYPESAFE_API_KEY.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Test seam: replaces the real Jev provider. */
  provider?: DecisionProvider;
}

function parse(argv: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        budget: { type: "string" },
        "no-jev": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    return { values, positionals };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Runs the CLI and returns the exit code. Results go to stdout only on success; everything else to stderr. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parse(argv);
    if (values.help || argv.length === 0) {
      io.stdout(HELP);
      return 0;
    }
    if (positionals.length !== 1)
      throw new UsageError('Expected exactly one task description, in quotes: scope "<task>"');
    const { result, decision } = await runScope({
      task: positionals[0]!,
      repo: values.repo,
      budget: values.budget === undefined ? undefined : Number(values.budget),
      noJev: values["no-jev"],
      provider: io.provider,
    });
    for (const warning of result.warnings) io.stderr(`scope: warning: ${warning}\n`);
    if (decision) {
      const { inputTokens, outputTokens } = decision.usage ?? {};
      io.stderr(`scope: Jev ${decision.latencyMs}ms, ${inputTokens} input / ${outputTokens} output tokens\n`);
    }
    io.stdout(renderResult(result));
    return 0;
  } catch (error) {
    io.stderr(`scope: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
