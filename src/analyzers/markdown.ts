import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, Analyzer, CodeChunk, TokenEstimator } from "../types.ts";

export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"] as const;

interface Heading {
  /** 0-based index of the first line of the heading (the text line for a setext heading). */
  start: number;
  level: number;
  text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INDENTED = /^(?: {4}|\t)/;
const BLOCK_START = /^ {0,3}(?:>|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+[ \t]*$/;

/** The line index after a leading `---` front matter block, or 0 when the file has none. */
function frontMatterEnd(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
  return close === -1 ? 0 : close + 1;
}

/**
 * Finds ATX and setext headings outside fenced code. A `---` under a paragraph is a setext heading, not a thematic
 * break; an unclosed fence runs to the end of the file. Callers pass lines without their `\r`.
 */
function findHeadings(lines: string[], from: number): Heading[] {
  const headings: Heading[] = [];
  let fence: { char: string; length: number } | undefined;
  /** First line of the paragraph being read, if any. */
  let paragraph: number | undefined;
  for (let index = from; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      paragraph = undefined;
      continue;
    }
    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline && paragraph !== undefined) {
      const text = lines
        .slice(paragraph, index)
        .map((part) => part.trim())
        .join(" ");
      headings.push({ start: paragraph, level: underline[1]![0] === "=" ? 1 : 2, text });
      paragraph = undefined;
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      headings.push({ start: index, level: atx[1]!.length, text: (atx[2] ?? "").replace(CLOSING_HASHES, "").trim() });
      paragraph = undefined;
    } else if (line.trim() === "" || THEMATIC_BREAK.test(line) || BLOCK_START.test(line)) {
      paragraph = undefined;
    } else if (paragraph === undefined && !INDENTED.test(line)) {
      paragraph = index;
    }
  }
  return headings;
}

/**
 * Extracts `section` chunks from one Markdown file. Content before the first heading (front matter included) is a
 * `preamble` section unless blank. Each heading starts a section that runs to the line before the next heading of the
 * same or a higher level, so a parent covers its children, and is named by its heading path (`Parent > Child`);
 * skipped levels (an h3 straight under an h1) attach to the nearest shallower heading. Ranges are 1-based, inclusive.
 */
export function extractMarkdownChunks(file: string, source: string, estimator: TokenEstimator): AnalysisResult {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const scanned = lines.map((line) => line.replace(/\r$/, ""));
  const headings = findHeadings(scanned, frontMatterEnd(scanned));
  const sections: { name: string; start: number; end: number }[] = [];
  const preambleEnd = headings[0]?.start ?? lines.length;
  if (lines.slice(0, preambleEnd).some((line) => line.trim() !== "")) {
    sections.push({ name: "preamble", start: 0, end: preambleEnd });
  }
  const path: Heading[] = [];
  const names: string[] = [];
  headings.forEach((heading, index) => {
    while (path.length > 0 && path.at(-1)!.level >= heading.level) {
      path.pop();
      names.pop();
    }
    path.push(heading);
    names.push(heading.text || "(empty heading)");
    const next = headings.slice(index + 1).find((other) => other.level <= heading.level);
    sections.push({ name: names.join(" > "), start: heading.start, end: next?.start ?? lines.length });
  });
  const chunks = sections.map(({ name, start, end }): CodeChunk => {
    const content = lines.slice(start, end).join("\n");
    return {
      id: makeChunkId({ file, startLine: start + 1, endLine: end, kind: "section", name }),
      file,
      language: "markdown",
      kind: "section",
      name,
      startLine: start + 1,
      endLine: end,
      content,
      references: [],
      estimatedTokens: estimator.count(content),
    };
  });
  return { chunks, warnings: [] };
}

export const markdownAnalyzer: Analyzer = {
  languages: ["markdown"],
  analyze: async (file, estimator) => extractMarkdownChunks(file.path, file.source, estimator),
};
