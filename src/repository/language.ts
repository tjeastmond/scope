import { posix } from "node:path";
import type { Language } from "../types.ts";

/**
 * How a file is turned into chunks: `semantic` is a code analyzer (symbols, references), `structural` is a
 * format-aware splitter (sections, keys, rules), `text` is the line-window fallback, and `skip` means never read.
 */
export type Strategy = "semantic" | "structural" | "text" | "skip";

export interface Classification {
  /** Absent only when the file is skipped. */
  language?: Language;
  strategy: Strategy;
  /** A short human explanation of the decision, for `--explain`. */
  reason: string;
}

interface FileType {
  language: Language;
  strategy: Exclude<Strategy, "skip">;
  /** Lowercase, with the leading dot. Only the last extension counts, so `.d.ts` is covered by `.ts`. */
  extensions: readonly string[];
  /** Lowercase base names of files recognized without an extension. */
  names?: readonly string[];
  /** Interpreter names found on a `#!` line, without version suffixes (`python3.12` is `python`). */
  interpreters?: readonly string[];
}

/** The one table behind classification: every language, strategy, extension, file name and interpreter. */
const FILE_TYPES: readonly FileType[] = [
  {
    language: "typescript",
    strategy: "semantic",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    interpreters: ["ts-node", "tsx"],
  },
  {
    language: "javascript",
    strategy: "semantic",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    interpreters: ["node", "nodejs", "bun", "deno"],
  },
  { language: "python", strategy: "semantic", extensions: [".py", ".pyi"], interpreters: ["python"] },
  { language: "sql", strategy: "structural", extensions: [".sql"] },
  { language: "html", strategy: "structural", extensions: [".html", ".htm"] },
  { language: "css", strategy: "structural", extensions: [".css"] },
  { language: "scss", strategy: "structural", extensions: [".scss"] },
  { language: "json", strategy: "structural", extensions: [".json", ".jsonc"] },
  { language: "yaml", strategy: "structural", extensions: [".yaml", ".yml"] },
  { language: "toml", strategy: "structural", extensions: [".toml"] },
  { language: "markdown", strategy: "structural", extensions: [".md", ".markdown"] },
  { language: "go", strategy: "text", extensions: [".go"] },
  { language: "java", strategy: "text", extensions: [".java"] },
  { language: "rust", strategy: "text", extensions: [".rs"] },
  {
    language: "text",
    strategy: "text",
    // prettier-ignore
    extensions: [
      ".txt", ".rst", ".adoc", ".csv", ".tsv", ".log", ".ini", ".cfg", ".conf", ".properties", ".xml", ".svg",
      ".sh", ".bash", ".zsh", ".fish", ".rb", ".php", ".pl", ".lua", ".r", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
      ".kt", ".kts", ".scala", ".swift", ".m", ".dart", ".ex", ".exs", ".erl", ".hs", ".clj", ".vue", ".svelte",
      ".less", ".graphql", ".gql", ".proto", ".tf", ".gradle", ".cmake", ".mk",
    ],
    // prettier-ignore
    names: [
      "dockerfile", "makefile", "gnumakefile", "rakefile", "gemfile", "procfile", "justfile", "readme", "license",
      "licence", "copying", "notice", "authors", "contributors", "changelog", "codeowners", ".gitignore",
      ".gitattributes", ".dockerignore", ".editorconfig", ".npmrc", ".nvmrc", ".prettierignore", ".eslintignore",
    ],
    interpreters: ["sh", "bash", "zsh", "dash", "ksh", "fish", "ruby", "perl", "php", "lua", "awk"],
  },
];

function indexBy(field: "extensions" | "names" | "interpreters"): Map<string, FileType> {
  return new Map(FILE_TYPES.flatMap((type) => (type[field] ?? []).map((key) => [key, type] as const)));
}

const byExtension = indexBy("extensions");
const byName = indexBy("names");
const byInterpreter = indexBy("interpreters");

/** Control characters other than tab, newline, vertical tab and carriage return, or a replacement character. */
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000e-\u001f�]/;

/** The interpreter named by a shebang line, with `env` and version suffixes resolved: `#!/usr/bin/env -S python3.12`. */
function interpreterOf(head: string): string | undefined {
  const line = head.split(/\r?\n/, 1)[0] ?? "";
  if (!line.startsWith("#!")) return undefined;
  const words = line.slice(2).trim().split(/\s+/);
  let command = posix.basename(words.shift() ?? "");
  if (command === "env") command = words.find((word) => !word.startsWith("-") && !word.includes("=")) ?? "";
  return posix.basename(command).replace(/[\d.]+$/, "") || undefined;
}

/**
 * Decides how a file is handled: by extension first, then well-known file name, then (for what is left) the
 * first bytes of its content, given as `head`. A shebang names the language; other content is text only when it
 * looks like text. With no `head`, an unrecognized file is skipped rather than guessed at.
 */
export function classifyFile(path: string, head?: string): Classification {
  const base = posix.basename(path);
  const extension = posix.extname(base).toLowerCase();
  const hasExtension = extension.length > 1;
  const byExt = hasExtension ? byExtension.get(extension) : undefined;
  if (byExt) return { language: byExt.language, strategy: byExt.strategy, reason: `extension ${extension}` };

  const named = byName.get(base.toLowerCase());
  if (named) return { language: named.language, strategy: named.strategy, reason: `well-known file name ${base}` };

  const interpreter = head === undefined ? undefined : interpreterOf(head);
  if (interpreter) {
    const type = byInterpreter.get(interpreter);
    if (type) return { language: type.language, strategy: type.strategy, reason: `shebang ${interpreter}` };
    return { language: "text", strategy: "text", reason: `script with shebang ${interpreter}` };
  }

  const what = hasExtension ? `unknown extension ${extension}` : "no extension";
  if (head === undefined) return { strategy: "skip", reason: `${what}, content not available to check` };
  if (NOT_TEXT.test(head)) return { strategy: "skip", reason: `${what}, content is not text` };
  return { language: "text", strategy: "text", reason: `${what}, content looks like text` };
}
