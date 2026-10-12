import { assembleChunks, type Region } from "./assemble.ts";
import type { AnalysisResult, Analyzer, ChunkKind } from "../types.ts";

// No WASM grammar loads for SQL (docs/grammars.md), so this is a small lexer plus a statement splitter.

type TokenType = "word" | "ident" | "string" | "punct";

interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

interface Span {
  start: number;
  end: number;
}

interface Statement {
  tokens: Token[];
  /** The top-level `;`, absent for a final unterminated statement. */
  terminator?: Token;
}

const WORD = /[\p{L}\p{N}_$]+/uy;
const DOLLAR_TAG = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;

/**
 * Splits source into code tokens and comment spans. Single-quoted strings, double-quoted and backtick identifiers
 * (doubled quote = escape) and dollar-quoted bodies are single tokens, so `;` inside them never splits. Backslash is
 * not an escape and block comments do not nest (standard SQL). Unterminated constructs run to the end of the file.
 */
function lex(source: string): { tokens: Token[]; comments: Span[]; unterminated: boolean } {
  const tokens: Token[] = [];
  const comments: Span[] = [];
  let unterminated = false;
  const closeAt = (from: number, delimiter: string): number => {
    const at = source.indexOf(delimiter, from);
    if (at >= 0) return at + delimiter.length;
    unterminated = true;
    return source.length;
  };
  const closeQuote = (start: number): number => {
    const quote = source[start]!;
    let from = start + 1;
    for (;;) {
      const at = source.indexOf(quote, from);
      if (at < 0) {
        unterminated = true;
        return source.length;
      }
      if (source[at + 1] !== quote) return at + 1;
      from = at + 2;
    }
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "-" && source[i + 1] === "-") {
      const newline = source.indexOf("\n", i);
      const end = newline < 0 ? source.length : newline;
      comments.push({ start: i, end });
      i = end;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = closeAt(i + 2, "*/");
      comments.push({ start: i, end });
      i = end;
    } else {
      let type: TokenType = "punct";
      let end = i + 1;
      DOLLAR_TAG.lastIndex = i;
      const tag = ch === "$" ? DOLLAR_TAG.exec(source) : null;
      WORD.lastIndex = i;
      const word = WORD.exec(source);
      if (ch === "'" || ch === '"' || ch === "`") {
        type = ch === "'" ? "string" : "ident";
        end = closeQuote(i);
      } else if (tag) {
        type = "string";
        end = closeAt(i + tag[0].length, tag[0]);
      } else if (word) {
        type = "word";
        end = i + word[0].length;
      }
      tokens.push({ type, text: source.slice(i, end), start: i, end });
      i = end;
    }
  }
  return { tokens, comments, unterminated };
}

const upper = (token: Token | undefined): string => (token?.type === "word" ? token.text.toUpperCase() : "");
const isName = (token: Token | undefined): token is Token => token?.type === "word" || token?.type === "ident";

const ROUTINE_OBJECTS = new Set(["TRIGGER", "PROCEDURE", "FUNCTION"]);
/** Objects whose CREATE header ends the search for a routine keyword (`CREATE TABLE t (function int)`). */
const PLAIN_OBJECTS = new Set([
  "TABLE",
  "VIEW",
  "INDEX",
  "TYPE",
  "SCHEMA",
  "SEQUENCE",
  "DATABASE",
  "EXTENSION",
  "DOMAIN",
]);
/** Words around which `begin` or `end` can only be a column name (`SELECT begin FROM t`, `SET end = 1`). */
const BEFORE_COLUMN = new Set(["SELECT", "SET", "WHERE", "AND", "OR", "BY", "ON"]);
const AFTER_COLUMN = new Set(["FROM"]);

/** A `begin`/`end` word used as an identifier: qualified, in a list, after a clause keyword, or compared. */
function isColumn(tokens: Token[], i: number): boolean {
  const [before, after] = [tokens[i - 1], tokens[i + 1]];
  return (
    (before?.type === "punct" && [".", ",", "("].includes(before.text)) ||
    (after?.type === "punct" && [".", ",", ")", "="].includes(after.text)) ||
    BEFORE_COLUMN.has(upper(before)) ||
    AFTER_COLUMN.has(upper(after))
  );
}
const BLOCK_CLOSERS = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR", "CASE", "TRY", "CATCH"]);
/** `BEGIN` followed by one of these starts a transaction or a `TRY`/`CATCH` section, not a counted block. */
const NOT_A_BLOCK = new Set(["TRANSACTION", "TRAN", "WORK", "DEFERRED", "IMMEDIATE", "EXCLUSIVE", "TRY", "CATCH"]);

/**
 * Change in BEGIN...END nesting at token `i`. Only routine bodies need it (`CREATE TRIGGER ... BEGIN a; b; END;`).
 * A block-closing `END` always follows a `;` (or an empty `BEGIN`), which tells it apart from `CASE ... END`
 * expressions and from a column named `end`; a column named `begin` is excluded by `isColumn`. `END IF`, `END LOOP` and `END CASE` close constructs that are never
 * counted as openers. T-SQL bodies that omit the `;` before their closing `END` are not recognized.
 */
function blockDelta(tokens: Token[], i: number): number {
  const word = upper(tokens[i]);
  if (word === "BEGIN") return NOT_A_BLOCK.has(upper(tokens[i + 1])) || isColumn(tokens, i) ? 0 : 1;
  if (word !== "END" || BLOCK_CLOSERS.has(upper(tokens[i + 1]))) return 0;
  const before = tokens[i - 1];
  return upper(before) === "BEGIN" || (before?.type === "punct" && before.text === ";") ? -1 : 0;
}

function isRoutineDefinition(head: Token[]): boolean {
  if (upper(head[0]) !== "CREATE") return false;
  for (const token of head.slice(1, 13)) {
    if (ROUTINE_OBJECTS.has(upper(token))) return true;
    if (PLAIN_OBJECTS.has(upper(token)) || token.text === "(") return false;
  }
  return false;
}

/** Splits at top-level `;`, ignoring semicolons inside parentheses and inside BEGIN...END bodies of routines. */
function splitStatements(tokens: Token[]): Statement[] {
  const statements: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;
  let parens = 0;
  tokens.forEach((token, index) => {
    if (token.type === "punct" && token.text === ";" && depth === 0 && parens === 0) {
      statements.push({ tokens: current, terminator: token });
      current = [];
      return;
    }
    current.push(token);
    if (token.type === "punct") parens = Math.max(0, parens + (token.text === "(" ? 1 : token.text === ")" ? -1 : 0));
    if (isRoutineDefinition(current)) depth += blockDelta(tokens, index);
  });
  if (current.length > 0) statements.push({ tokens: current });
  return statements;
}

const QUERY_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "VALUES", "REPLACE"]);
const MODIFIERS = new Set([
  "OR",
  "REPLACE",
  "TEMP",
  "TEMPORARY",
  "UNLOGGED",
  "GLOBAL",
  "LOCAL",
  "UNIQUE",
  "VIRTUAL",
  "RECURSIVE",
  "CONSTRAINT",
  "MATERIALIZED",
]);
const SKIPPED = new Set(["IF", "NOT", "EXISTS", "ONLY", "CONCURRENTLY"]);

/**
 * Object keywords and the chunk kind of a `CREATE` of that object: relations (tables, views, materialized views)
 * are `table`, routines and triggers are `function`, types and domains are `type`, everything else is `config`.
 */
const OBJECT_KIND = new Map<string, ChunkKind>([
  ["TABLE", "table"],
  ["VIEW", "table"],
  ["FUNCTION", "function"],
  ["PROCEDURE", "function"],
  ["TRIGGER", "function"],
  ["TYPE", "type"],
  ["DOMAIN", "type"],
  ["INDEX", "config"],
  ["SEQUENCE", "config"],
  ["SCHEMA", "config"],
  ["EXTENSION", "config"],
  ["DATABASE", "config"],
  ["ROLE", "config"],
  ["USER", "config"],
  ["POLICY", "config"],
]);
const CREATE_SCAN = 12;

/** Where a query's target table follows: after which keyword, within how many leading tokens. */
const TARGET_KEYWORD = new Map([
  ["INSERT", { keyword: "INTO", limit: 6 }],
  ["REPLACE", { keyword: "INTO", limit: 6 }],
  ["MERGE", { keyword: "INTO", limit: 6 }],
  ["DELETE", { keyword: "FROM", limit: 6 }],
  ["SELECT", { keyword: "FROM", limit: Infinity }],
]);

/** `a`, `"a"."b"` or `a.b` as written (without whitespace), starting at token `start`. */
function qualifiedName(tokens: Token[], start: number): string | undefined {
  if (!isName(tokens[start])) return undefined;
  let name = tokens[start].text;
  let i = start;
  while (tokens[i + 1]?.text === "." && isName(tokens[i + 2])) {
    name += `.${tokens[i + 2]!.text}`;
    i += 2;
  }
  return name;
}

/** The qualified name after the first top-level `keyword` within `limit` tokens (skipping `ONLY`). */
function nameAfter(tokens: Token[], keyword: string, limit: number): string | undefined {
  let depth = 0;
  for (let i = 1; i < Math.min(tokens.length, limit); i++) {
    const token = tokens[i]!;
    if (token.type === "punct") depth += token.text === "(" ? 1 : token.text === ")" ? -1 : 0;
    if (depth === 0 && upper(token) === keyword) {
      return qualifiedName(tokens, upper(tokens[i + 1]) === "ONLY" ? i + 2 : i + 1);
    }
  }
  return undefined;
}

function skipBalanced(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const text = tokens[i]!.type === "punct" ? tokens[i]!.text : "";
    depth += text === "(" ? 1 : text === ")" ? -1 : 0;
    if (depth === 0) return i + 1;
  }
  return tokens.length;
}

/** Names of the CTEs of a `WITH` statement: `WITH a AS (...), b(x) AS MATERIALIZED (...) SELECT ...`. */
function cteNames(tokens: Token[]): string[] {
  const names: string[] = [];
  let i = upper(tokens[1]) === "RECURSIVE" ? 2 : 1;
  while (isName(tokens[i])) {
    names.push(tokens[i]!.text);
    i++;
    if (tokens[i]?.text === "(") i = skipBalanced(tokens, i);
    if (upper(tokens[i]) !== "AS") break;
    i++;
    while (upper(tokens[i]) === "NOT" || upper(tokens[i]) === "MATERIALIZED") i++;
    if (tokens[i]?.text !== "(") break;
    i = skipBalanced(tokens, i);
    if (tokens[i]?.text !== ",") break;
    i++;
  }
  return names;
}

function updateTarget(tokens: Token[]): string | undefined {
  let i = 1;
  for (;;) {
    const word = upper(tokens[i]);
    if (word === "OR") i += 2;
    else if (word === "ONLY" || word === "LOW_PRIORITY" || word === "IGNORE") i++;
    else return qualifiedName(tokens, i);
  }
}

/** `insert into users`, `update users`, `delete from users`, `select from users`, `with a, b`, or the bare verb. */
function queryName(tokens: Token[], verb: string): string {
  if (verb === "WITH") return ["with", cteNames(tokens).join(", ")].filter(Boolean).join(" ");
  const rule = TARGET_KEYWORD.get(verb);
  const target = rule
    ? nameAfter(tokens, rule.keyword, rule.limit)
    : verb === "UPDATE"
      ? updateTarget(tokens)
      : undefined;
  const lower = tokens[0]!.text === "(" ? "query" : verb.toLowerCase();
  return target ? [lower, rule?.keyword.toLowerCase(), target].filter(Boolean).join(" ") : lower;
}

/** Kind and stable name for a statement that is not a query: CREATE definitions, and config for the rest. */
function definition(tokens: Token[], verb: string): { kind: ChunkKind; name: string } {
  let i = 1;
  while (i <= CREATE_SCAN && i < tokens.length && !OBJECT_KIND.has(upper(tokens[i]))) {
    if (verb !== "CREATE" && !MODIFIERS.has(upper(tokens[i]))) break;
    i++;
  }
  const kind = OBJECT_KIND.get(upper(tokens[i]));
  if (!kind) i = 1;
  const parts = [verb.toLowerCase()];
  if (kind) parts.push(tokens[i++]!.text.toLowerCase());
  while (SKIPPED.has(upper(tokens[i]))) i++;
  if (upper(tokens[i]) === "ON") {
    parts.push("on");
    i++;
  }
  const name = qualifiedName(tokens, i);
  if (name) parts.push(name);
  if (verb === "CREATE" && kind && kind !== "config" && name) return { kind, name };
  return { kind: "config", name: parts.join(" ") };
}

function classify(tokens: Token[]): { kind: ChunkKind; name: string } {
  const verb = upper(tokens[0]);
  if (tokens[0]!.text === "(" || QUERY_VERBS.has(verb)) return { kind: "query", name: queryName(tokens, verb) };
  return definition(tokens, verb);
}

/**
 * Extracts one chunk per top-level statement of a SQL file. A statement's range starts at its first token, extended
 * upward over comment-only lines directly attached to it (a blank line detaches them), and ends at the line of the
 * terminating `;`, or at the last token for a final statement without one. Statements that share a line share its
 * content; identical duplicates collapse to one chunk. Kinds: `table` (tables, views, materialized views),
 * `function` (functions, procedures, triggers), `type`, `query` (SELECT, INSERT, UPDATE, DELETE, MERGE, WITH,
 * VALUES, REPLACE), and `config` for everything else (indexes, ALTER, SET, PRAGMA, ...). Names derive from the
 * statement (`users`, `insert into users`, `alter table users`), never from an index.
 */
export async function extractSqlChunks(file: string, source: string): Promise<AnalysisResult> {
  const { tokens, comments, unterminated } = lex(source);
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  // Lines touched by a comment. A line that also holds code is never reached when attaching comments upward: the
  // lines just above a statement's first token hold only comments, or the previous statement (guarded by `previousEnd`).
  const commentLines = new Set<number>();
  for (const comment of comments) {
    for (let line = lineOf(comment.start); line <= lineOf(comment.end - 1); line++) commentLines.add(line);
  }

  const regions: Region[] = [];
  let previousEnd = 0;
  for (const statement of splitStatements(tokens)) {
    const last = statement.terminator ?? statement.tokens.at(-1)!;
    const endLine = lineOf(statement.terminator ? last.start : last.end - 1);
    if (statement.tokens.length > 0) {
      let startLine = lineOf(statement.tokens[0]!.start);
      while (startLine - 1 > previousEnd && commentLines.has(startLine - 1)) startLine--;
      regions.push({ startLine, endLine, ...classify(statement.tokens) });
    }
    previousEnd = endLine;
  }
  const { chunks, warnings } = assembleChunks(file, source, "sql", regions, false);
  if (unterminated) {
    warnings.push(
      `${file}: unterminated string, quoted identifier, comment or dollar-quoted body; the last statement runs to the end of the file`,
    );
  }
  return { chunks, warnings };
}

export const sqlAnalyzer: Analyzer = {
  languages: ["sql"],
  analyze: (file) => extractSqlChunks(file.path, file.source),
};
