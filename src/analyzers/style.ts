import type { Node } from "web-tree-sitter";
import type { Analyzer, Language, TokenEstimator } from "../types.ts";
import { assembleChunks, collapse, type Region } from "./assemble.ts";
import { parserFor } from "./parser.ts";

export const STYLE_EXTENSIONS = [".css", ".scss"] as const;

const VARIABLE = /^(\$[\w-]+|--[\w-]+)\s*:/;
const UNQUOTED_URL_START = /url\((?!\s*["'])/iy;

/**
 * Classifies one top-level statement. A rule or at-rule with a `{ }` body is a `style` chunk named by its prelude
 * (selector list, or `@media (...)`); a statement without a body (`@import`, `@use`, `@charset`, `$var: x`,
 * `--custom: x`) is a `config` chunk named by the variable or by the statement itself.
 */
function classify(text: string, preludeLength: number | undefined): Pick<Region, "kind" | "name"> {
  if (preludeLength !== undefined) return { kind: "style", name: collapse(text.slice(0, preludeLength)) };
  const statement = collapse(text.replace(/;\s*$/, ""));
  return { kind: "config", name: VARIABLE.exec(statement)?.[1] ?? statement };
}

/** Plain CSS through the Tree-sitter grammar: one region per top-level statement. */
async function cssRegions(file: string, source: string): Promise<{ regions: Region[]; broken: boolean }> {
  const parser = await parserFor("css");
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Tree-sitter could not parse ${file}`);
  try {
    const regions = tree.rootNode.namedChildren
      .filter((node): node is Node => node !== null && node.type !== "comment" && node.type !== "ERROR")
      .map((node) => {
        const body = node.namedChildren.find(
          (child) => child?.type === "block" || child?.type === "keyframe_block_list",
        );
        const prelude = body ? body.startIndex - node.startIndex : undefined;
        return {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...classify(node.text, prelude),
        };
      });
    return { regions, broken: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}

/**
 * SCSS has no WASM grammar, so top-level statements are found with a brace-depth scan. Strings, block and `//`
 * comments, `#{ }` interpolation and unquoted `url()` are skipped as opaque so the braces in them do not count.
 * Nesting needs no handling: everything inside a top-level `{ }` stays in that statement. Comments between statements
 * belong to no chunk.
 */
export function scssRegions(source: string): { regions: Region[]; broken: boolean } {
  const length = source.length;
  const starts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (index: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  let broken = false;
  // `end` of a comment starting at `i`, or -1.
  const comment = (i: number): number => {
    if (source[i] !== "/") return -1;
    if (source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      return newline === -1 ? length : newline;
    }
    if (source[i + 1] !== "*") return -1;
    const close = source.indexOf("*/", i + 2);
    broken ||= close === -1;
    return close === -1 ? length : close + 2;
  };
  // `end` of a string, comment, `url(...)` or `#{...}` starting at `i`, or -1.
  const opaque = (i: number): number => {
    const c = source[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      broken ||= source[j] !== c;
      return Math.min(j + 1, length);
    }
    if (c === "#" && source[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        const end = opaque(j);
        if (end >= 0) {
          j = end;
        } else {
          if (source[j] === "{") depth++;
          else if (source[j] === "}") depth--;
          j++;
        }
      }
      broken ||= depth > 0;
      return j;
    }
    if (c === "u" || c === "U") {
      UNQUOTED_URL_START.lastIndex = i;
      if (!UNQUOTED_URL_START.test(source)) return -1;
      // The closing `)` of an unquoted url, skipping `#{...}` so an interpolated call's own `)` does not end it.
      for (let j = UNQUOTED_URL_START.lastIndex; j < length;) {
        if (source[j] === ")") return j + 1;
        const end = source[j] === "#" ? opaque(j) : -1;
        j = end >= 0 ? end : j + 1;
      }
      return -1;
    }
    return comment(i);
  };

  const regions: Region[] = [];
  const push = (start: number, end: number, preludeEnd: number | undefined) => {
    const text = source.slice(start, end);
    regions.push({
      startLine: lineOf(start),
      endLine: lineOf(end - 1),
      ...classify(text, preludeEnd === undefined ? undefined : preludeEnd - start),
    });
  };

  let start: number | undefined;
  let preludeEnd: number | undefined;
  let depth = 0;
  for (let i = 0; i < length;) {
    if (start === undefined) {
      const end = comment(i);
      if (end >= 0 || /\s/.test(source[i] ?? "")) {
        i = end >= 0 ? end : i + 1;
        continue;
      }
      start = i;
    }
    const end = opaque(i);
    if (end >= 0) {
      i = end;
      continue;
    }
    const c = source[i++];
    if (c === "{") {
      if (depth++ === 0) preludeEnd = i - 1;
    } else if (c === "}") {
      if (depth === 0) {
        broken = true;
        if (start === i - 1) start = undefined;
      } else if (--depth === 0) {
        push(start, i, preludeEnd);
        start = preludeEnd = undefined;
      }
    } else if (c === ";" && depth === 0) {
      push(start, i, undefined);
      start = undefined;
    }
  }
  if (start !== undefined) {
    // End of file inside a statement: keep it up to the last non-blank character.
    broken ||= depth > 0;
    push(start, source.trimEnd().length, preludeEnd);
  }
  return { regions, broken };
}

/**
 * Extracts one chunk per top-level rule or at-rule from a CSS or SCSS file (`.scss` by path, else CSS): `@media`,
 * `@supports`, `@keyframes` and the like are single chunks, SCSS nesting stays inside its parent rule, and body-less
 * statements (`@import`, `@use`, `$var: x`, `--custom: x`) are `config` chunks. Unclosed braces keep the statement up
 * to the end of the file and add a warning.
 */
export async function extractStyleChunks(file: string, source: string, estimator: TokenEstimator) {
  const language: Language = file.toLowerCase().endsWith(".scss") ? "scss" : "css";
  const { regions, broken } = language === "scss" ? scssRegions(source) : await cssRegions(file, source);
  return assembleChunks(file, source, language, regions, broken, estimator);
}

export const styleAnalyzer: Analyzer = {
  languages: ["css", "scss"],
  analyze: (file, estimator) => extractStyleChunks(file.path, file.source, estimator),
};
