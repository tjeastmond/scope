import type { Node } from "web-tree-sitter";
import type { Analyzer, Language } from "../types.ts";
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

/** At-rules without a block that the CSS grammar knows; any other `@name ...;` at the top level is neutralized. */
const KNOWN_BODYLESS_AT_RULES = new Set(["import", "charset", "namespace"]);

/** The shortest `@import x;` the neutral form fits in. */
const NEUTRAL_MIN_LENGTH = 10;

/**
 * Tailwind v4 adds block-less at-rules the CSS grammar cannot parse (`@custom-variant dark (&:is(.dark *));`,
 * `@source "../x";`, `@plugin`, `@config`, `@reference`): they come out as ERROR nodes, or swallow the next rule. The
 * parser gets a copy where each such top-level statement is a same-length `@import xxx;` (newlines kept), so offsets
 * and lines are unchanged and the statement stays one `config` chunk; chunk text and names come from the original.
 */
export function neutralizeBodylessAtRules(source: string): string {
  const length = source.length;
  let out = "";
  let copied = 0;
  let depth = 0;
  for (let i = 0; i < length;) {
    const c = source[i];
    if (c === '"' || c === "'") {
      i = skipString(source, i);
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? length : close + 2;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === "@" && depth === 0) {
      const name = /^@([\w-]+)/.exec(source.slice(i, i + 64))?.[1]?.toLowerCase();
      let end = i + 1;
      while (end < length && source[end] !== ";" && source[end] !== "{" && source[end] !== "}") {
        if (source[end] === '"' || source[end] === "'") end = skipString(source, end);
        else if (source[end] === "/" && source[end + 1] === "*") {
          const close = source.indexOf("*/", end + 2);
          end = close === -1 ? length : close + 2;
        } else end++;
      }
      const statement = source.slice(i, end + 1);
      if (
        name &&
        !KNOWN_BODYLESS_AT_RULES.has(name) &&
        source[end] === ";" &&
        statement.length >= NEUTRAL_MIN_LENGTH &&
        !statement.slice(0, 7).includes("\n")
      ) {
        // Everything after `@import` becomes x (newlines kept so lines hold), with one space so it reads as a url.
        const rest = statement.slice(7, -1).replace(/[^\n]/g, "x");
        const neutral = `@import${rest.startsWith("\n") ? "" : " "}${rest.startsWith("\n") ? rest : rest.slice(1)};`;
        out += source.slice(copied, i) + neutral;
        copied = end + 1;
      }
      i = Math.max(end, i + 1);
    } else {
      i++;
    }
  }
  return copied === 0 ? source : out + source.slice(copied);
}

/** Index after the string literal starting at `start` (a line break ends an unterminated one). */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length && source[i] !== quote && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, source.length);
}

/** Plain CSS through the Tree-sitter grammar: one region per top-level statement. */
async function cssRegions(file: string, source: string): Promise<{ regions: Region[]; broken: boolean }> {
  const parser = await parserFor("css");
  const tree = parser.parse(neutralizeBodylessAtRules(source));
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
          ...classify(source.slice(node.startIndex, node.endIndex), prelude),
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
export async function extractStyleChunks(file: string, source: string) {
  const language: Language = file.toLowerCase().endsWith(".scss") ? "scss" : "css";
  const { regions, broken } = language === "scss" ? scssRegions(source) : await cssRegions(file, source);
  return assembleChunks(file, source, language, regions, broken);
}

export const styleAnalyzer: Analyzer = {
  languages: ["css", "scss"],
  analyze: (file) => extractStyleChunks(file.path, file.source),
};
