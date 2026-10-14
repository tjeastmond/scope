/** What went wrong with one file during the scan; the key of the one-line stderr summary. */
export type FileWarningKind =
  "syntax-error" | "no-chunks" | "analyzer-failed" | "jsonc" | "binary" | "text-fallback" | "plain-text" | "other";

/** A per-file scan warning: the full message (as it appears in `ScopeResult.warnings`) plus its file and kind. */
export interface FileWarning {
  file: string;
  kind: FileWarningKind;
  message: string;
}

/** Message shapes after the `<path>: ` prefix, most specific first; they match what the analyzers and `textFallback` emit. */
const KIND_PATTERNS: [RegExp, FileWarningKind][] = [
  [/^syntax errors/, "syntax-error"],
  [/^analyzer extracted no chunks/, "no-chunks"],
  [/^analyzer failed/, "analyzer-failed"],
  [/^contains comments \(JSONC\)/, "jsonc"],
  [/^binary content/, "binary"],
  [/text fallback produced/, "text-fallback"],
];

/** Classifies one analyzer or scan warning about `file`. Anything unrecognized is `other`, never dropped. */
export function classifyFileWarning(file: string, message: string): FileWarning {
  const rest = message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message;
  return { file, kind: KIND_PATTERNS.find(([pattern]) => pattern.test(rest))?.[1] ?? "other", message };
}

const LABELS: Record<FileWarningKind, [one: string, many: string]> = {
  "syntax-error": ["syntax error", "syntax errors"],
  "no-chunks": ["no chunks", "no chunks"],
  "analyzer-failed": ["analyzer failure", "analyzer failures"],
  jsonc: ["JSONC", "JSONC"],
  binary: ["binary file", "binary files"],
  "text-fallback": ["text fallback", "text fallbacks"],
  "plain-text": ["plain text", "plain text"],
  other: ["other", "other"],
};

/** Warning kinds listed file by file in the artifact by default; every other kind is only counted (see `--explain`). */
export const LISTED_BY_DEFAULT: ReadonlySet<FileWarningKind> = new Set(["syntax-error"]);

/** Files with a scan warning, per kind; kinds without a warning are absent. The `warningSummary` of the artifact. */
export type WarningSummary = Partial<Record<FileWarningKind, number>>;

/** Counts files per kind (a file counts once per kind), in a fixed kind order so the output is deterministic. */
export function countFileWarnings(warnings: readonly FileWarning[]): WarningSummary {
  const perKind = new Map<FileWarningKind, Set<string>>();
  for (const { file, kind } of warnings) perKind.set(kind, (perKind.get(kind) ?? new Set()).add(file));
  const summary: WarningSummary = {};
  for (const kind of Object.keys(LABELS) as FileWarningKind[]) {
    const files = perKind.get(kind);
    if (files) summary[kind] = files.size;
  }
  return summary;
}

/** The warnings the artifact lists file by file without `--explain`; the CLI summarizes the rest on stderr. */
export const isOmittedByDefault = (warning: FileWarning): boolean => !LISTED_BY_DEFAULT.has(warning.kind);

/**
 * One stderr line for the per-file scan warnings the artifact does not list, with the number of files and a count per
 * kind (a file counts once per kind). Undefined when there are none. The hint appears because the artifact omits them.
 */
export function summarizeFileWarnings(warnings: readonly FileWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;
  const summary = countFileWarnings(warnings);
  const kinds = (Object.entries(summary) as [FileWarningKind, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${LABELS[kind][count === 1 ? 0 : 1]}`);
  const count = new Set(warnings.map((w) => w.file)).size;
  return `${count} ${count === 1 ? "more file had a scan warning" : "more files had scan warnings"} (${kinds.join(", ")}); rerun with --explain to list them`;
}

/** The same counts as a short phrase, for the markdown artifact. */
export function describeWarningSummary(summary: WarningSummary): string {
  return (Object.entries(summary) as [FileWarningKind, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${LABELS[kind][count === 1 ? 0 : 1]}`)
    .join(", ");
}
