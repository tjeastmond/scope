import { JevRequestError, JevResponseError, JevUnavailableError } from "./jev/errors.ts";
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

const FAILURE_LABELS: [new (...args: never[]) => Error, string][] = [
  [JevUnavailableError, "Jev unavailable"],
  [JevResponseError, "Jev returned an unusable response"],
  [JevRequestError, "Jev request not sent"],
];

/** One line naming the kind of failure first, so a Jev failure is never mistaken for a Scope or usage problem. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const label = FAILURE_LABELS.find(([type]) => error instanceof type)?.[1];
  return label ? `${label}: ${error.message}` : error.message;
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
      const metrics = [
        decision.latencyMs === undefined ? undefined : `${decision.latencyMs}ms`,
        inputTokens === undefined || outputTokens === undefined
          ? undefined
          : `${inputTokens} input / ${outputTokens} output tokens`,
      ].filter((metric) => metric !== undefined);
      io.stderr(`scope: Jev ${metrics.length > 0 ? metrics.join(", ") : "usage not reported"}\n`);
    }
    io.stdout(renderResult(result));
    return 0;
  } catch (error) {
    io.stderr(`scope: ${describeError(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
