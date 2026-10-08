import {
  JevAuthError,
  JevCancelledError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  JevUnavailableError,
} from "./jev/errors.ts";
import { exitCodeFor } from "./exit-codes.ts";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { prepareOutput, type PreparedOutput } from "./output/file.ts";
import { FORMATS, renderFormat, type OutputFormat } from "./output/index.ts";
import { CancelledError, UsageError } from "./errors.ts";
import {
  CacheControlError,
  cacheStatus,
  clearCache,
  formatBytes,
  formatStatus,
  rebuildCache,
} from "./cache/controls.ts";
import { resolveRepository } from "./repository/root.ts";
import { previewJevPayload, runScope } from "./scope.ts";
import type { DecisionProvider } from "./types.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--format text|markdown|json]
             [--output <path>] [--no-jev] [--explain] [--no-cache]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --format <format>  Output format: ${FORMATS.join(", ")} (default: text)
  --output <path>    Write the artifact to a file instead of stdout (default: stdout)
  --explain          Add selection evidence for every chunk (default: off)
  --no-jev           Skip Jev and use the offline baseline (no credentials or network)
  --no-cache         Do not read or write the local analysis cache in .scope/
  -h, --help         Show this help

Only the artifact goes to stdout (or to the --output file); warnings, Jev usage and the final "wrote" line go to
stderr. --output refuses to overwrite a source file of the repository and replaces other files atomically.

By default Scope sends the task and candidate source code to Jev and needs TYPESAFE_API_KEY.
SCOPE_CACHE=off also turns the cache off.
SCOPE_JEV_PAYLOAD=print prints the exact Jev request bodies to stdout instead of sending them (no key needed).

Cache commands:
  scope cache status  [--repo <path>] [--format text|json]   Show what the local cache holds
  scope cache clear   [--repo <path>] --yes                  Delete everything Scope stored in .scope/
  scope cache rebuild [--repo <path>]                        Reanalyze every file and rewrite the analysis cache
Run scope cache --help for details. To run a task that is literally the word cache: scope -- cache
`;

const CACHE_ACTIONS = ["status", "clear", "rebuild"] as const;
type CacheAction = (typeof CACHE_ACTIONS)[number];

const CACHE_HELP = `Usage: scope cache status  [--repo <path>] [--format text|json]
       scope cache clear   [--repo <path>] --yes
       scope cache rebuild [--repo <path>]

Inspect and control the local cache in <repo>/.scope/. None of these commands needs Jev or a task.

Commands:
  status   Read-only: store path, size, entries, version keys, last update and retention bounds.
           Creates nothing; --format json prints a stable object for scripts.
  clear    Delete the Scope store data in .scope/ (analysis cache and any run history, decisions or feedback).
           Requires --yes: there is no prompt. Never follows a symlinked .scope or store directory, and never
           touches anything outside .scope/ or the per-user integrity key. Files in the store that Scope did
           not create are left in place and reported.
  rebuild  Reanalyze every file and rewrite the analysis cache, ignoring cached entries. It touches only analysis
           data; other stored data is kept. Does not work with SCOPE_CACHE=off.

Options:
  --repo <path>      Repository (default: current directory)
  --format <format>  status only: text or json (default: text)
  --yes              clear only: confirm the deletion
  -h, --help         Show this help

Retention bounds (shown by status; used by features that keep history) can be set with SCOPE_HISTORY_MAX_RUNS,
SCOPE_HISTORY_MAX_DAYS, SCOPE_DECISIONS_MAX, SCOPE_DECISIONS_MAX_DAYS, SCOPE_FEEDBACK_MAX and SCOPE_FEEDBACK_MAX_DAYS.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Test seam: replaces the real Jev provider. */
  provider?: DecisionProvider;
  /** Aborted when the user cancels (Ctrl-C); stops the scan and the Jev request. Tests abort it without real signals. */
  signal?: AbortSignal;
}

/** A cache command: `scope cache status|clear|rebuild`. */
export interface CacheCliOptions {
  kind: "cache";
  help: boolean;
  /** Undefined only with `help`. */
  action?: CacheAction;
  repo: string;
  /** `status` only. */
  format: "text" | "json";
  /** `clear` only: the explicit confirmation. */
  yes: boolean;
}

export type CliOptions = RunCliOptions | CacheCliOptions;

export interface RunCliOptions {
  kind: "run";
  help: boolean;
  task: string;
  repo: string;
  format: OutputFormat;
  /** Destination file; undefined means stdout. */
  output?: string;
  noJev: boolean;
  explain: boolean;
  /** Use the local analysis cache in `.scope/`. Off with `--no-cache` or `SCOPE_CACHE=off`. */
  cache: boolean;
}

const OPTIONS = {
  repo: { type: "string" },
  format: { type: "string" },
  output: { type: "string" },
  explain: { type: "boolean" },
  "no-jev": { type: "boolean" },
  "no-cache": { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Parses argv with the shared option table; a failure becomes a UsageError with an actionable message. */
function parseOptions(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
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
}

const CACHE_TASK_FLAGS = ["format", "output", "explain", "no-jev", "no-cache"] as const;

/** `scope cache <action> ...`: the arguments after `cache`. */
function parseCacheCli(args: string[]): CacheCliOptions {
  const { values, positionals } = parseOptions(args);
  if (values.help) return { kind: "cache", help: true, repo: ".", format: "text", yes: false };
  const list = CACHE_ACTIONS.join(", ");
  if (positionals.length === 0) throw new UsageError(`Expected a cache subcommand: ${list}. Run scope cache --help.`);
  const action = positionals[0]!;
  if (!(CACHE_ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown cache subcommand "${action}". Use one of: ${list}.`);
  if (positionals.length > 1)
    throw new UsageError(`scope cache ${action} takes no arguments besides its options: got "${positionals[1]}".`);
  for (const flag of CACHE_TASK_FLAGS) {
    if (flag === "format" && action === "status") continue;
    if (values[flag] !== undefined)
      throw new UsageError(
        flag === "format"
          ? "--format only applies to scope cache status (text or json)."
          : `--${flag} applies to a task run, not to scope cache ${action}.`,
      );
  }
  if (values.yes && action !== "clear") throw new UsageError("--yes only applies to scope cache clear.");
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format for scope cache status must be text or json: got "${format}"`);
  const repo = values.repo ?? ".";
  if (!repo.trim()) throw new UsageError("--repo requires a path");
  resolveRepository(repo);
  if (action === "clear" && !values.yes) {
    const { root } = resolveRepository(repo);
    throw new UsageError(`scope cache clear deletes ${join(root, ".scope")}; rerun with --yes to confirm.`);
  }
  return { kind: "cache", help: false, action: action as CacheAction, repo, format, yes: values.yes ?? false };
}

/** Parses and validates every flag in one place, before anything is scanned. Throws UsageError. */
export function parseCli(argv: string[]): CliOptions {
  if (argv[0] === "cache") return parseCacheCli(argv.slice(1));
  const { values, positionals } = parseOptions(argv);
  if (values.yes) throw new UsageError("--yes only applies to scope cache clear.");
  const base = {
    noJev: values["no-jev"] ?? false,
    explain: values.explain ?? false,
    // Any SCOPE_CACHE value other than "off" leaves the cache on.
    cache: !(values["no-cache"] ?? false) && process.env.SCOPE_CACHE !== "off",
  };
  if (values.help || argv.length === 0) {
    return { ...base, kind: "run", help: true, task: "", repo: ".", format: "text" };
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

  return { ...base, kind: "run", help: false, task, repo, format: format as OutputFormat, output: values.output };
}

const FAILURE_LABELS: [new (...args: never[]) => Error, string][] = [
  [CancelledError, "Cancelled"],
  [JevCancelledError, "Cancelled"],
  [JevUnavailableError, "Jev unavailable"],
  [JevResponseError, "Jev returned an unusable response"],
  [JevRequestError, "Jev request not sent"],
];

const NO_JEV = "or rerun with --no-jev for the offline baseline (no Jev judgment).";

/** Setup or retry guidance per Jev failure (most specific class first); it always names --no-jev as the user's choice. */
const GUIDANCE: [new (...args: never[]) => Error, string][] = [
  [JevCancelledError, ""],
  [JevAuthError, `Set TYPESAFE_API_KEY to a valid TypeSafe key, ${NO_JEV}`],
  [JevRateLimitError, `Wait a moment and retry, ${NO_JEV}`],
  [JevTimeoutError, `Retry; if it keeps timing out, narrow the task or point --repo at a smaller directory, ${NO_JEV}`],
  [JevUnavailableError, `Check your network connection and retry later, ${NO_JEV}`],
  [JevResponseError, `Retry; if it persists, report it with the message above, ${NO_JEV}`],
  [JevRequestError, `Narrow the task or point --repo at a smaller directory, ${NO_JEV}`],
];

const guidanceFor = (error: unknown): string | undefined =>
  GUIDANCE.find(([type]) => error instanceof type)?.[1] || undefined;

/** One line naming the kind of failure first, so a Jev failure is never mistaken for a Scope or usage problem. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const label = FAILURE_LABELS.find(([type]) => error instanceof type)?.[1];
  return label ? `${label}: ${error.message}` : error.message;
}

/** Whether SCOPE_JEV_PAYLOAD=print asks for the payload audit; rejects every unusable combination. */
function payloadMode(options: RunCliOptions): boolean {
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
    if (options.kind === "cache") {
      if (options.help) io.stdout(CACHE_HELP);
      else await runCache(options, io);
      return 0;
    }
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
    const guidance = guidanceFor(error);
    if (guidance) io.stderr(`scope: ${guidance}\n`);
    return exitCodeFor(error);
  }
}

async function runCache(options: CacheCliOptions, io: Io): Promise<void> {
  if (options.action === "status") {
    const status = await cacheStatus(options.repo);
    io.stdout(options.format === "json" ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    for (const warning of status.retention.warnings) io.stderr(`scope: warning: ${warning}\n`);
  } else if (options.action === "clear") {
    const result = await clearCache(options.repo);
    for (const item of result.left) io.stderr(`scope: warning: left ${item.path} in place (${item.reason})\n`);
    if (result.nothingToClear) {
      io.stdout("Nothing to clear: no Scope store found.\n");
      return;
    }
    const documents = result.stores.reduce((sum, store) => sum + store.documents, 0);
    const bytes = result.stores.reduce((sum, store) => sum + store.bytes, 0);
    io.stdout(
      `Cleared ${result.stores.length} store${result.stores.length === 1 ? "" : "s"}: removed ${documents} documents (${formatBytes(bytes)}).\n`,
    );
  } else if (options.action === "rebuild") {
    const result = await rebuildCache(options.repo, { signal: io.signal });
    for (const warning of result.warnings) io.stderr(`scope: warning: ${warning}\n`);
    if (!result.committed) throw new CacheControlError("the rebuilt analysis could not be written to the cache.");
    io.stdout(
      `Rebuilt the analysis cache: ${result.filesAnalyzed} files analyzed, ${result.chunks} chunks, ${(result.elapsedMs / 1000).toFixed(1)}s.\n`,
    );
  }
}

async function run(options: RunCliOptions, io: Io, output: PreparedOutput | undefined): Promise<void> {
  const { result, decision } = await runScope({
    task: options.task,
    repo: options.repo,
    explain: options.explain,
    noJev: options.noJev,
    cache: options.cache,
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
