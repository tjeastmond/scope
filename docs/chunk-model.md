# Chunk model

Every analyzer (`src/analyzers/`) implements `Analyzer` from `src/types.ts` and turns one `SourceFile` into an
`AnalysisResult` of normalized `CodeChunk` records plus non-fatal `warnings`. `analyzeFile` in
`src/analyzers/index.ts` dispatches by language through the registry.

## Line ranges and content

- `startLine` and `endLine` are 1-based and inclusive.
- `content` is the exact source text of the lines the chunk spans, from the start of `startLine` to the end of
  `endLine`, without the final line terminator. Any text on those lines outside the declaration is included.
- **CRLF:** lines are counted by `\n`. A CRLF file therefore yields the same ranges, and the same chunk IDs, as its LF
  equivalent. `content` keeps the original text: lines are split on `\n` only, so every `\r` is preserved, including the
  one that ends the last line of a CRLF chunk. Nothing is normalized.
- `file` is repository-relative with `/` separators.

## Kinds and nesting

- Declarations are chunks of kind `function`, `class`, `interface`, `type`, and so on (see `ChunkKind`).
- Nested symbols are separate chunks. A method is a `method` chunk named `Class.method` (accessors are
  `Class.get name` / `Class.set name`); the `class` chunk still covers the whole class, so the two ranges overlap.
  How overlap is handled during selection is refined in issue #33.
- The `file` kind is for whole-file chunks: the fallback for files with no recognized structure (plain text, or
  formats where the file is the natural unit). Its range is the entire file and it usually has no `name`.

## Python

`src/analyzers/python.ts` handles `.py` and `.pyi`. It extracts boundaries and names only (`references` is empty;
imports and calls are issue #27, class/method overlap is issue #33).

- Module-level `def` and `async def` are `function` chunks; methods (including `async`, `@staticmethod`,
  `@classmethod`, `@property`) are `method` chunks named `Class.method`. Stub signatures (`def f(): ...`) are ordinary
  functions or methods.
- A class chunk covers the whole class. Nested classes are `class` chunks named `Outer.Inner`, their methods
  `Outer.Inner.method`. Functions nested in functions, and classes defined inside function bodies, are not separate
  chunks; the parent covers them.
- Decorators and docstrings are inside the range: ranges come from the `decorated_definition` node.
- Property accessors share a name, so `@x.setter` is `Class.set x`, `@x.getter` is `Class.get x` and `@x.deleter` is
  `Class.delete x`; the plain `@property` getter stays `Class.x`. Other same-name redefinitions (`@overload`, a function
  defined twice) keep the same name and are told apart by range, hence by ID.
- Module-level assignments are `config` chunks, one per statement, named by the target, when the single target is
  UPPER_CASE (`MAX_RETRIES`, `_LIMIT`) or annotated (`counter: int = 0`). Tuple targets and lower-case unannotated
  assignments are skipped.
- `if __name__ == "__main__":` (without `else`) is a `section` chunk named `__main__`.
- Syntax errors: declarations whose subtree has an error or a missing token are skipped; the rest are extracted and
  `warnings` gets `<path>: syntax errors; extracted N declarations from the parseable regions`. A non-empty file with
  nothing extractable returns that warning and no chunks (the text fallback is issue #32).

## SQL

`src/analyzers/sql.ts` handles SQL. No WASM grammar loads for SQL (`docs/grammars.md`), so it is a small lexer plus a
statement splitter. `references` is empty.

- One chunk per top-level statement, split on `;`. Single-quoted strings, double-quoted and backtick identifiers
  (doubled quote = escape), `--` and `/* */` comments (not nested) and dollar-quoted bodies (`$$...$$`, `$tag$...$tag$`)
  never split. Backslash is not an escape. Semicolons inside parentheses (`CREATE RULE ... DO ALSO (a; b)`) do not split either. For
  `CREATE ... TRIGGER|PROCEDURE|FUNCTION`, semicolons inside a
  `BEGIN ... END` body do not split either. A block-closing `END` is one that follows a `;` or `BEGIN`, which keeps `CASE ... END`
  expressions and a column named `end` from closing it; `BEGIN TRANSACTION` and `BEGIN TRY` open nothing. Known limit: a
  T-SQL body that omits the `;` before its closing `END` is not recognized and runs to the end of the file's statements.
- Range: starts at the statement's first token, extended upward over comment-only lines directly above it (a blank line
  detaches them, and lines of the previous statement's terminating line are never claimed); ends at the line of the
  terminating `;`, or at the last token for a final statement without one (trailing comments and blank lines are not
  included). Statements on one line share that line as their content; identical duplicates collapse to one chunk.
- Kinds: `table` for `CREATE [TEMP|UNLOGGED|...] TABLE` and for views and materialized views (named relations);
  `function` for functions, procedures and triggers; `type` for `CREATE TYPE`/`DOMAIN`; `query` for `SELECT`, `INSERT`,
  `UPDATE`, `DELETE`, `MERGE`, `REPLACE`, `VALUES`, `WITH` and parenthesized queries; `config` for everything else
  (indexes, sequences, extensions, `ALTER`, `DROP`, `SET`, `PRAGMA`, `BEGIN`/`COMMIT`, ...).
- Names are derived from the statement, never from an index. Definitions use the object name as written, qualified
  (`app.accounts`, `"app"."users"`). Queries are `insert into users`, `update users`, `delete from sessions`,
  `merge into stock`, `select from users` (first top-level `FROM` with a table), `with a, b` (CTE names), or the bare
  verb (`select`, `values`; `query` for a parenthesized query). Config statements are the lowercase verb, object and
  name (`create index idx_users_email`, `alter table users`, `set search_path`, `commit`).
- Unterminated string, identifier, comment or dollar-quoted body: the construct runs to the end of the file and
  `warnings` gets one `<path>: unterminated ...` entry. T-SQL `[bracket]` identifiers and MySQL `#` comments are not
  recognized.

## Paths

Every chunk `file` is a repository-relative path produced by `toRepoPath` (`src/repository/root.ts`): `/` separators, no
leading `./`, no `..` segments, and the on-disk spelling (no lowercasing, no Unicode normalization).

`resolveRepository` treats the `--repo` path as exactly the root. Scope never walks up to an enclosing git root, so a
subdirectory is scanned as its own repository. A symlinked `--repo` is resolved to its real path, so symlink-escape
checks compare files against a real root.

## Stable chunk IDs

`makeChunkId` (`src/chunk-id.ts`) hashes `file:startLine-endLine:kind:name` (SHA-256, first 12 hex characters).

- The same source gives the same IDs on every run.
- Two declarations with the same name in the same file occupy different ranges, so their IDs differ. Two chunks cannot
  share the full key, because that would mean the same kind and name over the same range in the same file.
- IDs are stable only for unchanged position: moving a declaration to other lines changes its ID, and so does editing
  it in a way that changes its line span.

## References

A `Reference` records a relationship found in a chunk: `kind` (`import`, `call`, `type`, `extends`, `implements`,
`style`, `test`), the `from` location, the `name` as written, an optional `targetChunkId`, and `evidence`:

- `exact`: the target was resolved from the language's own rules (for example an import path resolved to a file).
- `heuristic`: the target was inferred (for example by matching a name); it may be wrong.
- `unresolved`: no target was found. `targetChunkId` is absent.

Preserve uncertainty, never guess silently: an analyzer must pick the weakest evidence that is true, and must not set
`targetChunkId` without saying how it was found. The TypeScript analyzer emits no references yet.

## JavaScript and TypeScript

One analyzer (`src/analyzers/ecmascript.ts`) serves both languages. The grammar comes from the file path: `.ts`, `.mts`,
`.cts` and `.d.ts` use `typescript`, `.tsx` uses `tsx`, and `.js`, `.jsx`, `.mjs`, `.cjs` use `javascript` (which also
parses JSX). Chunk `language` is `typescript` for the TS family and `javascript` for the JS family. Chunks come from
top-level statements only; `references` is empty (issue #27).

| Source                                                                                                          | Kind                    | Name                           |
| --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------ |
| function, generator, `const`/`let`/`var` bound arrow/function                                                   | `function`              | the binding                    |
| the above when named `Uppercase`, or default-exported, and it contains JSX or is typed `FC`/`FunctionComponent` | `component`             | the binding                    |
| class (abstract, `const C = class {}`)                                                                          | `class`                 | the class                      |
| method, accessor, `#private`, `static`, `handler = () => {}`                                                    | `method`                | `Class.name`, `Class.get name` |
| interface, type alias                                                                                           | `interface`, `type`     | the declaration                |
| enum                                                                                                            | `type` (no `enum` kind) | the enum                       |
| exported constant that is not a function or class, `export default <expression>`                                | `config`                | the binding, or `default`      |
| top-level `describe(...)`                                                                                       | `section`               | `describe: <title>`            |
| top-level `it(...)` / `test(...)` (not inside a describe)                                                       | `function`              | `test: <title>`                |

Choices:

- **Ranges** include the `export`/`declare` wrapper and any decorators (class decorators, and method/field decorators,
  which Tree-sitter places as siblings of the member). Leading comments are not included.
- **Classes and methods** overlap as described above (class chunk covers the whole class; issue #33 owns the policy).
  Constructors and non-function fields are not chunks.
- **Anonymous default exports** are named `default` (`export default function () {}`, `export default class {}`,
  `export default () => ...`, `export default {...}`). `export default someIdentifier` has no chunk.
- **Not chunks:** nested functions and classes (they stay inside their parent), namespaces/modules (`namespace`,
  `declare module`, with their contents), `export { a, b }` and `export ... from` re-exports, imports, unexported
  non-function constants, destructured exports (`export const { a } = obj`), and CommonJS or `export =` assignments
  (`module.exports = ...`, `exports.x = ...`).
- **Test blocks:** `.only`/`.skip`/`.todo`/`.concurrent`/`.failing` variants count (also chained, as in `test.concurrent.only`);
  `.each(...)(...)` tables and `test.describe` are not recognized. Tests nested in a `describe` are covered by the
  describe chunk. Non-string titles use the argument's source text. Only top-level calls are recognized. Identical same-line
  declarations collapse to one chunk so ids stay unique.
- **Overloads:** a run of directly adjacent same-name signatures (functions, or class methods) is merged with the
  implementation that follows into one chunk spanning the first signature to the end of the implementation. Signatures
  with no following implementation (`declare function`, abstract methods, `.d.ts`) merge with each other into one chunk;
  anything between two declarations (another statement or a different name) separates them.
- **Ambient declarations** (`declare function/class/const`, `.d.ts`) are chunks; `declare const` counts as exported only
  when written `export declare const`.
- **Syntax errors:** a top-level statement that contains an error or missing node is skipped (a class with an error
  anywhere inside is skipped whole). The rest are extracted and `warnings` gets
  `<path>: syntax errors; extracted N declarations from the parseable regions`. A file with nothing extractable returns
  only the warning and no chunks; the whole-file text fallback is issue #32.

## Markdown

`src/analyzers/markdown.ts` is a line scanner, because no Markdown WASM grammar loads (docs/grammars.md). `references`
is empty.

- Every chunk is a `section`. Content before the first heading is a `preamble` section (omitted when blank); YAML front
  matter (a leading `---` block closed by `---` or `...`) belongs to it.
- ATX headings (`#` to `######`, up to three spaces of indent, optional closing hashes) and setext headings (a paragraph
  over `===` or `---`, the heading starting at the paragraph's first line) each start a section. Text in fenced code
  blocks (``` or `~~~`, closed by the same character at least as long; an unclosed fence runs to the end of the file) is
  never a heading, and `---`, `***` and `___` thematic breaks are not headings. HTML comments (`<!--` to `-->`) are
  skipped the same way, and lines continuing a list item or blockquote never start a setext heading. Front matter
  needs a non-blank line right after the opening `---`. A list item's indented paragraph after a blank line still counts as a new paragraph, so a `---` right
  under it reads as a setext underline (a known limitation).
- A section runs to the line before the next heading of the same or a higher level, so a parent's range covers its
  children (as a class covers its methods). Its `name` is the heading path, `Parent > Child`, from the nearest
  shallower heading at each step: an h3 directly under an h1 is `H1 > H3`. Heading text is kept as written (inline
  formatting included) minus closing hashes; an empty heading is `(empty heading)`.
- Headings with the same path are told apart by range, hence by ID.

## JSON, YAML and TOML

One analyzer (`src/analyzers/config.ts`) serves the three config languages. The format comes from the file extension
(`.json`, `.yaml`/`.yml`, `.toml`; anything else is read as JSON). Each top-level entry is one `config` chunk named after
its key, with the exact source lines it spans; `references` is empty. Chunks are flat: nothing nested inside an entry is
a chunk, so `package.json` `scripts` and `dependencies` are each one chunk (named `scripts`, `dependencies`), not one
per script or package.

| Format | Chunk                                         | Name                                                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| JSON   | each key of the top-level object              | the key, unquoted and unescaped (an empty key is `""`)                          |
| YAML   | each key of each document's top-level mapping | the key, unquoted; in a multi-document file `doc[N].key` (N is 0-based)         |
| TOML   | each root-level key before the first table    | the key, dotted keys joined (`metadata.team`)                                   |
| TOML   | each `[table]`                                | the dotted header (`dependencies.serde`); quoted parts keep quotes (`"a.b"`)    |
| TOML   | each `[[array of tables]]` element            | the dotted header plus the element index (`bin[0]`, `bin[1]`), counted per file |

Choices:

- **Non-mapping roots:** a top-level JSON array or scalar, or a YAML document that is a sequence or scalar, becomes one
  `file` chunk covering it (unnamed, or `doc[N]` in a multi-document YAML file). Empty YAML documents and empty or
  comment-only files give no chunks and no warning.
- **Ranges** are the entry itself: a YAML or JSON pair, or a TOML key, or a TOML table from its header to its last key.
  Leading comments above an entry, and the blank lines and comments between a TOML table and the next header, are not
  included. TOML sub-tables (`[a]`, `[a.b]`) are siblings, not nested. Anchors (`&x`), tags and block scalars are part of
  their entry; aliases are not resolved. `<<` merge keys are chunks named `<<`.
- **One-line files:** entries that share a line range (minified JSON, flow YAML) collapse into one `file` chunk for that
  range rather than repeating the whole line once per key. YAML directives (`%YAML`, `%TAG`) are not content.
- **Large files:** the scanner's size limits decide what is parsed at all; this analyzer parses whatever it is given.
- **JSONC:** comments are accepted and add the warning `<path>: contains comments (JSONC); parsed leniently`. Trailing
  commas are syntax errors (below).
- **Syntax errors:** entries are looked up inside error nodes too, so what parsed is kept (an entry whose value contains
  an error is still a chunk) and `warnings` gets `<path>: syntax errors; extracted N entries from the parseable regions`.
  A file with nothing extractable returns only the warning; the whole-file text fallback is issue #32.
- Identical same-line entries (`{"a": 1, "a": 2}`) collapse to one chunk so ids stay unique.
