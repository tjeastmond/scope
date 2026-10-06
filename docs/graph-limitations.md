# Repository graph limitations

The graph (`src/graph/`) links chunks through their import `references` and links test files to source files. It is
built to be cheap and traceable, not complete. Every edge carries `confidence` (`exact`, `heuristic`, `unresolved`) and
human-readable `evidence`.

- **Resolution is minimal.** Aliases (`@/x`, tsconfig `paths`), package `exports`, workspaces and bundler resolution
  are not resolved. Bare package specifiers (`react`, `logging`) are external. Such imports stay as dangling
  `unresolved` edges with the reason; they are never dropped.
- **Dynamic imports are unresolved.** `import(expr)`, `require(expr)`, `__import__(expr)` and template or concatenated
  specifiers have no specifier to resolve and become dangling edges ("dynamic specifier").
- **Usage is textual.** A file-level import (the analyzers attach it to every chunk of the file) creates edges only from
  chunks whose text mentions the imported name as a whole word. Shadowing, comments and strings can cause false
  positives. An import no chunk mentions, or one without a usable name (`default`, `*`, side effects), is anchored on the
  first chunk of the file.
- **Whole-module targets are file-only.** Default, namespace and re-exported imports, and names with no matching chunk,
  produce a `heuristic` edge to the file (`toFile`) and no chunk edge, so they do not appear in `neighbors`.
  A chunk is matched by exact `name` equality; when several share a name the first by line wins.
- **No call, type or inheritance edges.** The analyzers emit import references only, so the graph holds no
  function-call, type-use, `extends` or `implements` relationships yet.
- **No cross-language links.** A TypeScript file is never linked to the Python worker or to SQL it queries.
- **Test links are heuristic.** A test file is a `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py` file or one under a
  `tests`, `__tests__` or `test` directory. Imports from a test to a non-test file give `exact` test edges. Otherwise a
  same-stem file of the same language is linked by naming convention (`heuristic`); with several candidates, the one
  sharing the longest directory prefix wins, and a tie keeps all of them, marked ambiguous. Test edges are anchored on
  the first chunk of the test file and point at a file, not a chunk.
- **Python absolute imports** of local modules resolve only if the configured resolver says so.
