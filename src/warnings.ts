/** What went wrong with one file during the scan; the key of the one-line stderr summary. */
export type FileWarningKind =
  "syntax-error" | "no-chunks" | "analyzer-failed" | "jsonc" | "binary" | "text-fallback" | "other";

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
  other: ["other", "other"],
};

/**
 * One stderr line for all per-file scan warnings, with the number of files and a count per kind (a file counts once per
 * kind). Undefined when there are none.
 */
export function summarizeFileWarnings(warnings: readonly FileWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;
  const perKind = new Map<FileWarningKind, Set<string>>();
  for (const { file, kind } of warnings) perKind.set(kind, (perKind.get(kind) ?? new Set()).add(file));
  const kinds = [...perKind]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([kind, files]) => `${files.size} ${LABELS[kind][files.size === 1 ? 0 : 1]}`);
  const count = new Set(warnings.map((w) => w.file)).size;
  return `${count} ${count === 1 ? "file had a scan warning" : "files had scan warnings"} (${kinds.join(", ")}); rerun with --explain to list them`;
}
