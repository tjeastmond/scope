import { JevRequestError, JevResponseError, JevUnavailableError } from "./jev/errors.ts";
import { parseArgs } from "node:util";
import { DEFAULT_BUDGET } from "./config.ts";
import { prepareOutput, type PreparedOutput } from "./output/file.ts";
import { FORMATS, renderFormat, type OutputFormat } from "./output/index.ts";
import { UsageError } from "./errors.ts";
import { resolveRepository } from "./repository/root.ts";
import { runScope } from "./scope.ts";
import type { DecisionProvider } from "./types.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--budget <tokens>] [--format text|markdown|json]
             [--output <path>] [--no-jev] [--explain]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --budget <tokens>  Estimated token budget, a positive integer (default: ${DEFAULT_BUDGET})
  --format <format>  Output format: ${FORMATS.join(", ")} (default: text)
  --output <path>    Write the artifact to a file instead of stdout (default: stdout)
  --explain          Add selection evidence for every chunk; it counts toward the budget (default: off)
  --no-jev           Skip Jev and use the offline baseline (no credentials or network)
  -h, --help         Show this help

Only the artifact goes to stdout (or to the --output file); warnings, Jev usage and the final "wrote" line go to
stderr. --output refuses to overwrite a source file of the repository and replaces other files atomically.

By default Scope sends the task and candidate source code to Jev and needs TYPESAFE_API_KEY.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Test seam: replaces the real Jev provider. */
  provider?: DecisionProvider;
}

export interface CliOptions {
  help: boolean;
  task: string;
  repo: string;
  budget: number;
  format: OutputFormat;
  /** Destination file; undefined means stdout. */
  output?: string;
  noJev: boolean;
  explain: boolean;
}

/** Parses and validates every flag in one place, before anything is scanned. Throws UsageError. */
export function parseCli(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        budget: { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        explain: { type: "boolean" },
        "no-jev": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const base = { noJev: values["no-jev"] ?? false, explain: values.explain ?? false };
  if (values.help || argv.length === 0) {
    return { ...base, help: true, task: "", repo: ".", budget: DEFAULT_BUDGET, format: "text" };
  }
  if (positionals.length !== 1)
    throw new UsageError('Expected exactly one task description, in quotes: scope "<task>"');
  const task = positionals[0]!;
  if (!task.trim()) throw new UsageError('The task description is empty. Pass it in quotes: scope "<task>"');

  const format = values.format ?? "text";
  if (!(FORMATS as readonly string[]).includes(format))
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}: got "${format}"`);

  let budget = DEFAULT_BUDGET;
  if (values.budget !== undefined) {
    budget = /^\d+$/.test(values.budget) ? Number(values.budget) : 0;
    if (!Number.isSafeInteger(budget) || budget <= 0)
      throw new UsageError(`--budget must be a positive integer (digits only): got "${values.budget}"`);
  }

  const repo = values.repo ?? ".";
  if (!repo.trim()) throw new UsageError("--repo requires a path");
  resolveRepository(repo); // fails before anything is scanned

  if (values.output !== undefined && !values.output.trim()) throw new UsageError("--output requires a path");

  return { ...base, help: false, task, repo, budget, format: format as OutputFormat, output: values.output };
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

/** Runs the CLI and returns the exit code. Results go to stdout (or the --output file) only on success. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const options = parseCli(argv);
    if (options.help) {
      io.stdout(HELP);
      return 0;
    }
    // Checked, and the directory probed, before the (possibly paid) Jev request.
    const output =
      options.output === undefined
        ? undefined
        : await prepareOutput(resolveRepository(options.repo).root, options.output);
    try {
      await run(options, io, output);
      return 0;
    } finally {
      await output?.discard();
    }
  } catch (error) {
    io.stderr(`scope: ${describeError(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

async function run(options: CliOptions, io: Io, output: PreparedOutput | undefined): Promise<void> {
  const { result, decision } = await runScope({
    task: options.task,
    repo: options.repo,
    budget: options.budget,
    format: options.format,
    explain: options.explain,
    noJev: options.noJev,
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
  const artifact = renderFormat(options.format, result);
  if (output) {
    await output.commit(artifact);
    io.stderr(`scope: wrote ${options.output}\n`);
  } else {
    io.stdout(artifact);
  }
}
