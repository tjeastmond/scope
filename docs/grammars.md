# Tree-sitter grammars

Scope parses with `web-tree-sitter` (WASM), so no native compilation is needed and the same code runs on Node 24+ and
Bun. Grammars load through `parserFor(grammar)` in `src/analyzers/parser.ts`, which initializes the runtime once and
caches one parser per grammar.

## Pinned versions

| Package                                  | Version | Role                           |
| ---------------------------------------- | ------- | ------------------------------ |
| `web-tree-sitter`                        | 0.25.10 | WASM runtime                   |
| `tree-sitter-wasms`                      | 0.1.13  | Prebuilt grammar `.wasm` files |
| `@tree-sitter-grammars/tree-sitter-yaml` | 0.7.1   | YAML grammar (see below)       |

All are pinned exactly in `package.json` (no `^`). The `.wasm` files are resolved from the installed dependencies at
runtime and are not part of the packed tarball (`npm pack` ships only `dist/` and the README), so a packed install gets
them from `node_modules`.

## Grammar availability

| Language   | Grammar name | Source                                   | Status                                         |
| ---------- | ------------ | ---------------------------------------- | ---------------------------------------------- |
| TypeScript | `typescript` | tree-sitter-wasms                        | supported                                      |
| TSX        | `tsx`        | tree-sitter-wasms                        | supported                                      |
| JavaScript | `javascript` | tree-sitter-wasms                        | supported (also used for JSX)                  |
| Python     | `python`     | tree-sitter-wasms                        | supported                                      |
| HTML       | `html`       | tree-sitter-wasms                        | supported                                      |
| CSS        | `css`        | tree-sitter-wasms                        | supported                                      |
| JSON       | `json`       | tree-sitter-wasms                        | supported                                      |
| TOML       | `toml`       | tree-sitter-wasms                        | supported                                      |
| YAML       | `yaml`       | `@tree-sitter-grammars/tree-sitter-yaml` | supported (see below)                          |
| SQL        | -            | none                                     | no WASM grammar: line/statement-based fallback |
| SCSS       | -            | none                                     | no WASM grammar: brace/line-based fallback     |
| Markdown   | -            | none                                     | no WASM grammar: heading-based fallback        |

### YAML

The `tree-sitter-yaml.wasm` in `tree-sitter-wasms` 0.1.13 does not work with `web-tree-sitter` 0.25: it imports C++
standard-library symbols the runtime does not provide, so `parser.parse()` throws `resolved is not a function`. The
`@tree-sitter-grammars/tree-sitter-yaml` package ships a compatible `tree-sitter-yaml.wasm`. That package also declares
an `install` script (`node-gyp-build`) for its optional native binding; it ships prebuilds for macOS and Linux
(arm64 and x64), so no compiler is needed on the supported platforms, and Scope uses only the `.wasm` file.

### Languages without a grammar

None of `tree-sitter-wasms`, `@vscode/tree-sitter-wasm`, `@derekstride/tree-sitter-sql`, `tree-sitter-sql`,
`tree-sitter-scss`, `@tree-sitter-grammars/tree-sitter-markdown` or `tree-sitter-markdown` ships a `.wasm` for SQL, SCSS
or Markdown. Building one needs the tree-sitter CLI and a WASM toolchain, which Scope does not take on. The decided
fallback for these languages is a small hand-written structural chunker (no Tree-sitter), to be specified in each
language's own issue:

- SQL: split on top-level statements (`CREATE`, `ALTER`, `INSERT`, ... terminated by `;`).
- SCSS: split on top-level brace blocks and at-rules, using a brace-depth scan that ignores strings and comments.
- Markdown: split on ATX headings (`#`), ignoring fenced code blocks.

## Node verification

`bun run build` followed by `node scripts/check-grammars.mjs` loads every grammar from `dist/` and parses a sample.

| Node    | Result                                   |
| ------- | ---------------------------------------- |
| 24.19.0 | all 9 grammars load and parse, no errors |
| 26.10.0 | all 9 grammars load and parse, no errors |

`tests/grammars.test.ts` covers the same grammars under `bun test`.
