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
  resetWeights,
} from "./cache/controls.ts";
import { readBoundedFile } from "./bounded-input.ts";
import {
  MAX_FEEDBACK_FILE_BYTES,
  mergeFeedbackInput,
  parseFeedbackFile,
  submitFeedback,
  type FeedbackInput,
} from "./feedback.ts";
import { resolveRepository } from "./repository/root.ts";
import { previewJevPayload, runScope } from "./scope.ts";
import type { DecisionProvider } from "./types.ts";

const HELP = `Usage: scope "<task>" [--repo <path>] [--format text|markdown|json]
             [--output <path>] [--no-jev] [--explain] [--fresh] [--no-cache]

Select the smallest useful code context for a task.

Options:
  --repo <path>      Repository to analyze (default: current directory)
  --format <format>  Output format: ${FORMATS.join(", ")} (default: text)
  --output <path>    Write the artifact to a file instead of stdout (default: stdout)
  --explain          Add selection evidence for every chunk (default: off)
  --no-jev           Skip Jev and use the offline baseline (no credentials or network)
  --fresh            Ask Jev again instead of reusing an identical earlier decision; the new decision is cached
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
  scope cache reset-weights [--repo <path>]                  Remove adaptive retrieval weights; use the baseline again
Run scope cache --help for details. To run a task that is literally the word cache: scope -- cache

Feedback:
  scope feedback <run-id> [--useful <chunk-id>]... [--irrelevant <chunk-id>]... [--missing <path:start-end|path|symbol>]...
Tell Scope what turned out to be useful. Run scope feedback --help for details. To run a task that is literally the
word feedback: scope -- feedback
`;

const CACHE_ACTIONS = ["status", "clear", "rebuild", "reset-weights"] as const;
type CacheAction = (typeof CACHE_ACTIONS)[number];

const CACHE_HELP = `Usage: scope cache status  [--repo <path>] [--format text|json]
       scope cache clear   [--repo <path>] --yes
       scope cache rebuild [--repo <path>]
       scope cache reset-weights [--repo <path>]

Inspect and control the local cache in <repo>/.scope/. None of these commands needs Jev or a task.

Commands:
  status   Read-only: store path, size, entries, version keys, last update and retention bounds.
           Creates nothing; --format json prints a stable object for scripts.
  clear    Delete the Scope store data in .scope/ (analysis cache and any run history, decisions or feedback).
           Requires --yes: there is no prompt. Never follows a symlinked .scope or store directory, and never
           touches anything outside .scope/ or the per-user integrity key. Files in the store that Scope did
           not create are left in place and reported.
  rebuild  Reanalyze every file and rewrite the analysis cache, ignoring cached entries. On a current cache it
           touches only analysis data; a stale cache (another root or other version keys) is reset entirely,
           as by any run. Does not work with SCOPE_CACHE=off.
  reset-weights  Remove the adaptive retrieval weights, if any, so runs use the baseline weights exactly again.
           Analysis, history, feedback and decisions stay. status shows the active weights version, or baseline.

Options:
  --repo <path>      Repository (default: current directory)
  --format <format>  status only: text or json (default: text)
  --yes              clear only: confirm the deletion
  -h, --help         Show this help

Retention bounds (shown by status; used by features that keep history) can be set with SCOPE_HISTORY_MAX_RUNS,
SCOPE_HISTORY_MAX_DAYS, SCOPE_DECISIONS_MAX, SCOPE_DECISIONS_MAX_DAYS, SCOPE_FEEDBACK_MAX and SCOPE_FEEDBACK_MAX_DAYS.
SCOPE_ADAPTIVE=off makes runs ignore adaptive retrieval weights and use the baseline (like SCOPE_MEMORY=off for memory).
`;

const FEEDBACK_HELP = `Usage: scope feedback <run-id> [--useful <chunk-id>]... [--irrelevant <chunk-id>]...
                          [--missing <path:start-end|path|symbol>]... [--agent <name>]
                          [--file <path|->] [--repo <path>] [--format text|json]

Record which chunks of an earlier run turned out useful, irrelevant or missing. The run id is the "Run" line of a
Scope result (and the runId of its JSON). Feedback is only recorded: it changes nothing about later runs yet.
It needs the local cache and a run recorded in it (Jev runs with the cache on).

Options:
  --useful <chunk-id>      A chunk of that run that helped. Repeat the flag for more (not comma separated).
  --irrelevant <chunk-id>  A chunk of that run that did not help. Repeat the flag for more.
  --missing <value>        Context that was needed but not in the result. Repeat the flag for more. A value is
                           classified in this order: path:start-end (1-based inclusive lines of an included file),
                           then a repository-relative path of an included file (the whole file), then the exact name
                           of a symbol (a chunk) in the current source.
  --agent <name>           Attribute the feedback to an agent (1 to 100 printable characters). Default: the user.
  --file <path|->          Read a JSON document from a file or stdin (-); its entries are added to the flags:
                           { "runId"?: string, "useful"?: string[], "irrelevant"?: string[],
                             "missing"?: string[], "agent"?: string }
  --repo <path>            Repository (default: current directory)
  --format <format>        Output format: text or json (default: text)
  -h, --help               Show this help

At most 200 entries per list, each up to 500 characters; at least one entry; a chunk cannot be both useful and
irrelevant. The whole submission is rejected, and nothing recorded, if any part is invalid. A chunk whose source
changed since the run is recorded as not current, with a warning. Source code and the task are never stored.
Feedback is kept up to SCOPE_FEEDBACK_MAX entries and SCOPE_FEEDBACK_MAX_DAYS days. SCOPE_CACHE=off disables it.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Test seam: replaces the real Jev provider. */
  provider?: DecisionProvider;
  /** Aborted when the user cancels (Ctrl-C); stops the scan and the Jev request. Tests abort it without real signals. */
  signal?: AbortSignal;
  /**
   * Reads standard input to the end as UTF-8 (`scope feedback --file -`), failing with a UsageError once more than
   * `maxBytes` bytes arrive. Tests inject a string.
   */
  readStdin?: (maxBytes: number) => Promise<string>;
}

/** A feedback command: `scope feedback <run-id> ...`. */
export interface FeedbackCliOptions {
  kind: "feedback";
  help: boolean;
  repo: string;
  format: "text" | "json";
  /** The flags (and positional run id); `file` is read when the command runs. */
  input: FeedbackInput;
  file?: string;
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

export type CliOptions = RunCliOptions | CacheCliOptions | FeedbackCliOptions;

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
  /** Ask Jev again instead of reusing an identical earlier decision from the cache. */
  fresh: boolean;
  /** Use the local analysis cache in `.scope/`. Off with `--no-cache` or `SCOPE_CACHE=off`. */
  cache: boolean;
}

const OPTIONS = {
  repo: { type: "string" },
  format: { type: "string" },
  output: { type: "string" },
  explain: { type: "boolean" },
  "no-jev": { type: "boolean" },
  fresh: { type: "boolean" },
  "no-cache": { type: "boolean" },
  yes: { type: "boolean" },
  useful: { type: "string", multiple: true },
  irrelevant: { type: "string", multiple: true },
  missing: { type: "string", multiple: true },
  agent: { type: "string" },
  file: { type: "string" },
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

const CACHE_TASK_FLAGS = ["format", "output", "explain", "no-jev", "fresh", "no-cache"] as const;
/** Flags that only `scope feedback` takes. */
const FEEDBACK_ONLY_FLAGS = ["useful", "irrelevant", "missing", "agent", "file"] as const;
/** Task-run flags that make no sense for `scope feedback`. */
const FEEDBACK_REJECTED_FLAGS = ["output", "explain", "no-jev", "fresh", "no-cache", "yes"] as const;

function rejectFeedbackFlags(values: Record<string, unknown>, command: string): void {
  for (const flag of FEEDBACK_ONLY_FLAGS) {
    if (values[flag] !== undefined)
      throw new UsageError(`--${flag} only applies to scope feedback, not to ${command}.`);
  }
}

/** `scope feedback <run-id> ...`: the arguments after `feedback`. */
function parseFeedbackCli(args: string[]): FeedbackCliOptions {
  const { values, positionals } = parseOptions(args);
  const empty: FeedbackInput = { useful: [], irrelevant: [], missing: [] };
  if (values.help) return { kind: "feedback", help: true, repo: ".", format: "text", input: empty };
  for (const flag of FEEDBACK_REJECTED_FLAGS) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} applies to a task run, not to scope feedback.`);
  }
  if (positionals.length > 1) {
    throw new UsageError(`scope feedback takes one run id and its options: got extra argument "${positionals[1]}".`);
  }
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format for scope feedback must be text or json: got "${format}"`);
  const repo = values.repo ?? ".";
  if (!repo.trim()) throw new UsageError("--repo requires a path");
  resolveRepository(repo);
  if (values.file !== undefined && !values.file.trim()) throw new UsageError("--file requires a path (or - for stdin)");
  return {
    kind: "feedback",
    help: false,
    repo,
    format,
    ...(values.file === undefined ? {} : { file: values.file }),
    input: {
      ...(positionals[0] === undefined ? {} : { runId: positionals[0] }),
      useful: values.useful ?? [],
      irrelevant: values.irrelevant ?? [],
      missing: values.missing ?? [],
      ...(values.agent === undefined ? {} : { agent: values.agent }),
    },
  };
}

/** `scope cache <action> ...`: the arguments after `cache`. */
function parseCacheCli(args: string[]): CacheCliOptions {
  const { values, positionals } = parseOptions(args);
  if (values.help) return { kind: "cache", help: true, repo: ".", format: "text", yes: false };
  rejectFeedbackFlags(values, "scope cache");
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
  if (argv[0] === "feedback") return parseFeedbackCli(argv.slice(1));
  const { values, positionals } = parseOptions(argv);
  rejectFeedbackFlags(values, "a task run");
  if (values.yes) throw new UsageError("--yes only applies to scope cache clear.");
  const base = {
    noJev: values["no-jev"] ?? false,
    explain: values.explain ?? false,
    fresh: values.fresh ?? false,
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
    if (options.kind === "feedback") {
      if (options.help) io.stdout(FEEDBACK_HELP);
      else await runFeedback(options, io);
      return 0;
    }
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
        cache: options.cache,
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

/** The JSON document of `--file`, from a file or (for `-`) standard input. */
async function readFeedbackFile(path: string, io: Io): Promise<FeedbackInput> {
  if (path === "-") {
    if (!io.readStdin) throw new UsageError("--file - needs standard input, which is not available.");
    return parseFeedbackFile(await io.readStdin(MAX_FEEDBACK_FILE_BYTES), "standard input");
  }
  return parseFeedbackFile(await readBoundedFile(path, MAX_FEEDBACK_FILE_BYTES, path), path);
}

async function runFeedback(options: FeedbackCliOptions, io: Io): Promise<void> {
  const file = options.file === undefined ? undefined : await readFeedbackFile(options.file, io);
  const result = await submitFeedback(mergeFeedbackInput(options.input, file), {
    repo: options.repo,
    signal: io.signal,
  });
  if (io.signal?.aborted) throw new CancelledError();
  for (const warning of result.warnings) io.stderr(`scope: warning: ${warning}\n`);
  const { counts } = result;
  io.stdout(
    options.format === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Recorded feedback ${result.feedbackId} for run ${result.runId}: ${counts.useful} useful, ${counts.irrelevant} irrelevant, ${counts.missing} missing\n`,
  );
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
  } else if (options.action === "reset-weights") {
    const result = await resetWeights(options.repo);
    io.stdout(
      result.removed
        ? "Removed the adaptive retrieval weights; runs use the baseline weights.\n"
        : "No adaptive retrieval weights were active; runs already use the baseline weights.\n",
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
    reuseDecisions: !options.fresh,
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
