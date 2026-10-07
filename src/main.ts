import { JevCancelledError, JevRequestError, JevResponseError, JevUnavailableError } from "./jev/errors.ts";
import { parseArgs } from "node:util";
import { prepareOutput, type PreparedOutput } from "./output/file.ts";
import { FORMATS, renderFormat, type OutputFormat } from "./output/index.ts";
import { CancelledError, UsageError } from "./errors.ts";
import { resolveRepository } from "./repository/root.ts";
import { previewJevPayload, runScope } from "./scope.ts";
import type { DecisionProvider } from "./types.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--format text|markdown|json]
             [--output <path>] [--no-jev] [--explain]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --format <format>  Output format: ${FORMATS.join(", ")} (default: text)
  --output <path>    Write the artifact to a file instead of stdout (default: stdout)
  --explain          Add selection evidence for every chunk (default: off)
  --no-jev           Skip Jev and use the offline baseline (no credentials or network)
  -h, --help         Show this help

Only the artifact goes to stdout (or to the --output file); warnings, Jev usage and the final "wrote" line go to
stderr. --output refuses to overwrite a source file of the repository and replaces other files atomically.

By default Scope sends the task and candidate source code to Jev and needs TYPESAFE_API_KEY.
SCOPE_JEV_PAYLOAD=print prints the exact Jev request bodies to stdout instead of sending them (no key needed).
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Test seam: replaces the real Jev provider. */
  provider?: DecisionProvider;
  /** Aborted when the user cancels (Ctrl-C); stops the scan and the Jev request. Tests abort it without real signals. */
  signal?: AbortSignal;
}

export interface CliOptions {
  help: boolean;
  task: string;
  repo: string;
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
        format: { type: "string" },
        output: { type: "string" },
        explain: { type: "boolean" },
        "no-jev": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw new UsageError(message);
    // The default hint is about positional arguments; what a caller needs is the list of real options.
    const unknown = message.split(". ")[0]!;
    throw new UsageError(
      unknown.includes("'--budget'")
        ? `${unknown}. Scope has no token budget: it returns everything relevant to the task.`
        : `${unknown}. Run scope --help for the options.`,
    );
  }
  const { values, positionals } = parsed;
  const base = { noJev: values["no-jev"] ?? false, explain: values.explain ?? false };
  if (values.help || argv.length === 0) {
    return { ...base, help: true, task: "", repo: ".", format: "text" };
  }
  if (positionals.length !== 1)
    throw new UsageError('Expected exactly one task description, in quotes: scope "<task>"');
  const task = positionals[0]!;
  if (!task.trim()) throw new UsageError('The task description is empty. Pass it in quotes: scope "<task>"');

  const format = values.format ?? "text";
  if (!(FORMATS as readonly string[]).includes(format))
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}: got "${format}"`);

  const repo = values.repo ?? ".";
  if (!repo.trim()) throw new UsageError("--repo requires a path");
  resolveRepository(repo); // fails before anything is scanned

  if (values.output !== undefined && !values.output.trim()) throw new UsageError("--output requires a path");

  return { ...base, help: false, task, repo, format: format as OutputFormat, output: values.output };
}

const FAILURE_LABELS: [new (...args: never[]) => Error, string][] = [
  [CancelledError, "Cancelled"],
  [JevCancelledError, "Cancelled"],
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

/** Whether SCOPE_JEV_PAYLOAD=print asks for the payload audit; rejects every unusable combination. */
function payloadMode(options: CliOptions): boolean {
  const value = process.env.SCOPE_JEV_PAYLOAD;
  if (value === undefined || value === "") return false;
  if (value !== "print") throw new UsageError(`SCOPE_JEV_PAYLOAD must be "print" (or unset): got "${value}"`);
  if (options.noJev)
    throw new UsageError("SCOPE_JEV_PAYLOAD=print has nothing to print with --no-jev: nothing is sent.");
  if (options.output !== undefined)
    throw new UsageError("SCOPE_JEV_PAYLOAD=print always writes the payload to stdout; remove --output.");
  return true;
}

/** Runs the CLI and returns the exit code. Results go to stdout (or the --output file) only on success. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const options = parseCli(argv);
    if (options.help) {
      io.stdout(HELP);
      return 0;
    }
    const payload = payloadMode(options);
    if (payload) {
      const { requests, candidateCount } = await previewJevPayload({
        task: options.task,
        repo: options.repo,
        signal: io.signal,
      });
      if (io.signal?.aborted) throw new CancelledError();
      io.stdout(`${JSON.stringify(requests, null, 2)}\n`);
      io.stderr(
        `scope: printed the Jev payload (${requests.length} requests, ${candidateCount} candidates); nothing was sent\n`,
      );
      return 0;
    }
    // Checked, and the directory probed, before the (possibly paid) Jev request.
    const output =
      options.output === undefined
        ? undefined
        : await prepareOutput(resolveRepository(options.repo).root, options.output, io.signal);
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
    explain: options.explain,
    noJev: options.noJev,
    provider: io.provider,
    signal: io.signal,
  });
  // A Ctrl-C that lands after Jev answered still cancels: nothing is printed or written.
  if (io.signal?.aborted) throw new CancelledError();
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
