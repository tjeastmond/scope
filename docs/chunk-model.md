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
  `declare module`, with their contents), `export { a, b }` and `export ... from` re-exports, imports, and unexported
  non-function constants.
- **Test blocks:** `.only`/`.skip`/`.todo`/`.concurrent` variants count. Tests nested in a `describe` are covered by the
  describe chunk. Non-string titles use the argument's source text. Only top-level calls are recognized.
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
