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
  `Class.get name` / `Class.set name`). How a class and its methods are split is the container policy below.
- The `file` kind is for whole-file chunks: the fallback for files with no recognized structure (plain text, or
  formats where the file is the natural unit). Its range is the entire file and it usually has no `name`.

## Containers: classes, namespaces and their members

A class (JavaScript, TypeScript, Python, including nested classes) and a TypeScript `namespace`/`module` are
**containers**. Their members would otherwise be double-charged (a whole-class chunk plus a chunk per method), so
`assembleChunks` (`src/analyzers/assemble.ts`) applies one policy to every analyzer that gives a `Region` a `parent`:

- **Split.** The container becomes a **header chunk** and each member keeps its own chunk. The header runs from the
  container's first line (decorators and `export` included) to the last non-blank line before its first member chunk,
  so it holds the signature, decorators, docstring, fields and a constructor placed before the first method, never a
  method body. Its kind and name are the container's (`class` named `Cart`; `section` named `Shapes` for a namespace).
  Members are `method` chunks (`Cart.add`) and, in a namespace, the declarations in its body named
  `Namespace.member` (`Shapes.area`, `Shapes.Box.size`); a class or namespace inside a container is itself split the
  same way.
- **Links.** Every member chunk carries `parentId` (the header chunk's id) and `containerName` (its name). A header
  nested in another container carries them too, so the chain up to the outermost header can be followed. Top-level
  chunks have neither field.
- **Small containers stay whole.** A container of at most `SMALL_CONTAINER_LINES` (5) lines is one chunk spanning
  all of it, with no member chunks and no links. The same happens when splitting cannot keep ranges apart: the first
  member starts on the container's first line (`class A { m() {} }` spread over several lines), or two members share a
  line.
- **Invariant.** Within a file no two chunks overlap. The only permitted overlap would be a chunk and an ancestor reached
  through `parentId`; headers are cut short precisely so that it never occurs. M4's overlap merge can rely on both.
- **Known limit.** Non-method members after the first method (fields, a constructor, a static block) are in no chunk,
  because a header is one contiguous range. Functions and methods are never containers: functions nested in them stay
  inside their chunk (as before), so nothing overlaps.
- Ids still hash `file:startLine-endLine:kind:name`, so a header's id differs from the id the whole class had.

## Python

`src/analyzers/python.ts` handles `.py` and `.pyi`. It extracts boundaries and names, plus import references (see "References");
classes follow the container policy above.

- Module-level `def` and `async def` are `function` chunks; methods (including `async`, `@staticmethod`,
  `@classmethod`, `@property`) are `method` chunks named `Class.method`. Stub signatures (`def f(): ...`) are ordinary
  functions or methods.
- A class larger than the small-container limit is a header chunk (decorators, `class` line, docstring and class-level
  statements before the first method or nested class) with its methods and nested classes as separate chunks; see
  Containers. A small class is one chunk covering all of it. Nested classes are `class` chunks named `Outer.Inner`, their methods
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
  nothing extractable returns that warning and no chunks; `analyzeFile` then applies the text fallback (below).

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

## HTML

`src/analyzers/markup.ts` handles `.html` and `.htm` with the Tree-sitter `html` grammar (`references` is empty).

- Chunks are the **top-level landmarks**: `header`, `main`, `nav`, `section`, `form`, `template`, `article`, `aside`,
  `footer`. `<template>` is a `template` chunk; the others are `section`. Other elements (`html`, `body`, `div`, ...) are
  looked through, so a landmark inside a plain `div` is found. Anything inside a landmark stays in it: no nested chunks.
- Inline `<script>` is a `section` chunk and inline `<style>` a `style` chunk (there is no `script` kind). The range
  runs from the opening-tag line to the closing-tag line, so offsets are the real file lines. Blocks with no content
  (`<script src="x"></script>`, `<style></style>`) are not chunks. Scripts and styles inside a landmark are part of it.
- Names: `tag#id`, else `tag "aria-label"`, else `tag.first-class`, else `tag "first heading text"` (landmarks only
  contain headings), else the bare tag (`script`, `style`). Whitespace is collapsed.
- Syntax errors: the parser recovers around unclosed elements. Error nodes are looked through, so landmarks before and
  after the damage are kept; an unclosed landmark whose end tag is missing is not a chunk. The warning is
  `<path>: syntax errors; extracted N chunks from the parseable regions`. Unclosed `<html>`/`<body>`/`<p>` are valid
  HTML and do not warn. A file with no landmarks or blocks has no chunks, so `analyzeFile` applies the text fallback (below).

## CSS and SCSS

`src/analyzers/style.ts` handles `.css` (Tree-sitter `css` grammar) and `.scss` (no grammar exists, see
`docs/grammars.md`: a brace-depth scanner). Both produce the same shape; `language` is `scss` for `.scss`, else `css`.

- One chunk per **top-level** statement. A rule or at-rule with a `{ }` body is a `style` chunk named by its prelude
  with whitespace collapsed: the selector list (`a, b > c`), or the at-rule (`@media (min-width: 1px)`,
  `@keyframes spin`, `@mixin bp($n)`, `@include bp(10px)`). `@media`/`@supports`/`@layer {}` blocks are single chunks
  with their nested rules inside; SCSS nesting stays inside its parent rule.
- A top-level statement without a body is a `config` chunk: `@charset`, `@import`, `@use`, `@forward`, `@namespace`,
  `@layer a, b;`, `@include foo;`, and variables. Variables (`$var: ...`, `--custom: ...`) are named by the variable
  alone; other statements by their text without the `;`.
- The SCSS scanner skips strings, `/* */` and `//` comments, `#{ }` interpolation (nested braces included) and
  unquoted `url(...)` when counting braces and looking for `;`. Comments between statements belong to no chunk.
- Syntax errors: an unclosed `{` keeps the statement up to the end of the file; a stray `}`, an unterminated
  string, comment or interpolation is skipped or ends at the file end. Each adds the warning
  `<path>: syntax errors; extracted N chunks from the parseable regions`. A top-level statement at end of file with no
  `;` is kept. Empty or comment-only files have no chunks and no warning.

## Text fallback

`src/analyzers/text.ts` (`textFallback`) is the single fallback, applied by `analyzeFile` so every file still yields
usable chunks. Analyzers themselves never fall back; they set `AnalysisResult.partial` when the parser reported syntax
errors.

| Situation                                                     | Result                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Language with no analyzer (Go, Java, Rust, unknown text)      | Text windows over the whole file; reason `no analyzer for language "<language>"`.                |
| The analyzer throws                                           | Text windows over the whole file; reason `analyzer failed (<message>)`, one bounded line.        |
| The analyzer returns no chunks for a file with non-blank text | Text windows over the whole file; reason `analyzer extracted no chunks`.                         |
| The analyzer recovered chunks but flagged syntax errors       | Recovered chunks kept; windows only over lines no recovered chunk spans; reason `syntax errors`. |
| A NUL byte anywhere in the source                             | Not analyzed: no chunks, warning `<path>: binary content (NUL byte); skipped`.                   |

- **Windows:** about 80 lines (`TEXT_WINDOW_LINES`). A window ends on the blank line nearest the 80th line when one lies
  between line 40 and the hard maximum of 100 lines (`TEXT_WINDOW_MAX_LINES`); otherwise it ends exactly at 80. Blank
  lines at a window's edges are trimmed and blank-only windows are dropped, so ranges are exact, never overlap, and
  every non-blank line is in exactly one chunk. A file that is one window with nothing recovered is a single `file`
  chunk; any other window is a `section`. Fallback chunks have no `name`; the range, hence the ID, tells them apart.
- **Gap filling** never overlaps a recovered chunk (overlap between recovered chunks, such as class and method, is
  untouched). Lines of a broken file that are not declarations, such as imports, are gaps too, so they get windows.
- **Warnings:** each fallback that produces chunks adds `<path>: <reason>; text fallback produced N line window(s)`
  (plus ` over the lines the parser did not recover` when filling gaps), after the analyzer's own warnings. They flow
  into `ScopeResult.warnings`. A file with no non-blank line to cover (empty, blank-only) gets no chunks and no warning.
- **Binary content:** the scanner sniffs only the first 8 KiB, so a NUL after that reaches `analyzeFile`, which skips the
  file with a warning rather than parsing it or sending it anywhere. Files that do not look like text are never read as
  text (classification `skip`).
- Lines are the limit, not characters: a single huge line (minified code) is one window.

## Paths

Every chunk `file` is a repository-relative path produced by `toRepoPath` (`src/repository/root.ts`): `/` separators, no
leading `./`, no `..` segments, and the on-disk spelling (no lowercasing, no Unicode normalization).

`resolveRepository` treats the `--repo` path as exactly the root. Scope never walks up to an enclosing git root, so a
subdirectory is scanned as its own repository. A symlinked `--repo` is resolved to its real path, so symlink-escape
checks compare files against a real root.

## Scan limits and symlinks

`scanRepository` (`src/repository/files.ts`) visits entries in sorted order, so truncation is reproducible. The limits
are constants in `src/config.ts`:

| Constant         | Default | Effect                                                                      |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `MAX_FILE_BYTES` | 1 MB    | A larger file is skipped with reason `too-large` and never read.            |
| `MAX_SCAN_FILES` | 10,000  | The scan stops after this many eligible files and warns.                    |
| `MAX_SCAN_DEPTH` | 32      | Deeper directories (root = 0) are not entered; one warning names the first. |
| `MAX_SCAN_BYTES` | 50 MB   | The scan stops once eligible files total this size and warns.               |

Truncation warnings are returned as `ScanResult.warnings` and appear first in `ScopeResult.warnings`. Symlinks are
never followed, because an alias would dodge the secret, `.gitignore` and directory exclusions that apply to its
target, which is scanned under its own path anyway. A link whose real target is outside the repository root is skipped
as `symlink-outside-repository`, a directory link to its own directory or an ancestor as `symlink-loop`, any other link
as `symlink`, and a broken link or an unreadable file or directory as `unreadable`.

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
`targetChunkId` without saying how it was found.

### Import references (JavaScript, TypeScript, Python)

The JS/TS and Python analyzers record import and export relationships; nothing else (`call`, `type`, ... ) is emitted
yet. The analyzers never resolve targets, so `targetChunkId` is always absent; the repository graph (`src/graph/`)
resolves imports from `specifier` afterwards (see `docs/graph-limitations.md`). Every reference is
`{ kind: "import", from: { file, line }, name, specifier?, evidence? }` (`src/types.ts`):

- `from.line` is the 1-based first line of the statement or call it occurs in, so every binding of a multi-line
  `import { a, b } from "x"` shares that line. There is one reference per imported binding.
- `specifier` is the raw module specifier as written (`"./retry.ts"`, `"pkg"`, Python `"x.y"`, `".mod"`, `".."`,
  `"..pkg"`). It is absent when the specifier is not a literal.
- `evidence` is absent for a plain static specifier (no resolution attempted) and `"unresolved"` for a dynamic or
  computed one: `import(variable)`, `require(expr)`, a template literal with `${}`, string concatenation, Python
  `__import__(x)` or `importlib.import_module(f"...")`. Their `name` is the argument's source text (whitespace
  collapsed). They are never dropped.
- `name` for TS/JS: `default` for a default import; the symbol as written for named imports and `export { a as b }
from` (the left side, not the alias); the alias for `import * as ns` and `export * as ns from`; `*` for
  `export * from`; the specifier for side-effect imports, `require("x")` and `import("x")`; the local name for
  `import e = require("x")`. Type-only imports (`import type`, `{ type T }`) are ordinary `import` references: the
  type-only flag is not recorded, and `export ... from` re-exports use kind `import` too.
- `name` for Python: the dotted module for `import a.b`, or its alias for `import a as b` (`specifier` stays `a`);
  the symbol as written for `from x import y as z` (`y`); `*` for `from x import *`. `from __future__ import ...` has
  specifier `__future__`. Only `__import__` and `importlib.import_module` with a first argument are dynamic forms;
  other aliases of them are not detected.
- `local` is the name the file binds when it differs from `name`: `b` in `import { a as b }` and `from x import a as b`.
  Re-exports have none. `namespace: true` marks a binding of a whole module (`import * as ns`, Python `import a.b` and
  `import a as b`); `name` is then the binding, not a symbol of the target.
- `require` is matched by name without checking shadowing.

**Attachment.** A reference belongs to every chunk whose line range contains its `from.line`, so a `require` inside a
function is on that function (and a nested import in a Python function on that function only). Top-level imports and
`export ... from` statements lie outside every chunk range, so a reference whose line is in no chunk of the file is
file-level context and is attached to every chunk of that file (a file with only imports has no chunks and so no
references). That costs one copy per chunk, bounded by the scan limits. `references` are not sent to Jev and not
printed in the output; they are chunk data for M3's graph and the M6 cache.

## JavaScript and TypeScript

One analyzer (`src/analyzers/ecmascript.ts`) serves both languages. The grammar comes from the file path: `.ts`, `.mts`,
`.cts` and `.d.ts` use `typescript`, `.tsx` uses `tsx`, and `.js`, `.jsx`, `.mjs`, `.cjs` use `javascript` (which also
parses JSX). Chunk `language` is `typescript` for the TS family and `javascript` for the JS family. Chunks come from
top-level statements only; `references` holds imports, re-exports, `require` and dynamic `import()` (above).

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
- **Classes and methods** follow the container policy above (header chunk plus method chunks, or one chunk for a small
  class). Constructors and non-function fields are not chunks of their own; they belong to the header when they come
  before the first method.
- **Anonymous default exports** are named `default` (`export default function () {}`, `export default class {}`,
  `export default () => ...`, `export default {...}`). `export default someIdentifier` has no chunk.
- **Namespaces:** `namespace A.B {}`, `module X {}` and `declare module "x" {}` are containers: a `section` chunk
  named `A.B`/`X`/`x` (header only when split) and the declarations in the body, named `A.B.member`. `declare global`
  and body-less `declare module "x";` give nothing.
- **Not chunks:** nested functions and classes (they stay inside their parent), `export { a, b }` and `export ... from` re-exports, imports, unexported
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
  only the warning and no chunks; `analyzeFile` then applies the text fallback (below).

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
  A file with nothing extractable returns only the warning; `analyzeFile` then applies the text fallback (below).
- Identical same-line entries (`{"a": 1, "a": 2}`) collapse to one chunk so ids stay unique.
