# Changelog

All notable changes to Scope are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). The CLI contract (flags, output formats, the JSON schema
version and exit codes) is the public API.

## 0.1.0 - Unreleased

The first release of the `scope` command. It is not on npm yet; install it from a checkout as the README describes. The
package name `@tjeastmond/scope` is planned for a later npm release.

### Added

- `scope "<task>"` selects the code context a task needs from a local repository: Tree-sitter chunking, lexical and
  graph retrieval into a shortlist of up to 40 candidates, a Jev relevance judgment for every candidate through
  `@typesafe-ai/sdk`, and supporting declarations added for coherence. There is no size budget; everything Jev finds
  relevant is returned.
- Flags: `--repo`, `--format text|markdown|json`, `--output` (atomic, refuses to overwrite repository source),
  `--explain` (per-chunk selection evidence and every scan warning) and `--no-jev` (the offline deterministic baseline,
  no credentials or network).
- Versioned JSON output, plus text and Markdown artifacts with consistent result metadata.
- Languages: semantic analyzers for TypeScript and JavaScript (including TSX and JSX) and Python; structural chunking
  for SQL, HTML, CSS, SCSS, JSON/JSONC, YAML, TOML and Markdown; text windows for every other text file, including Go,
  Java and Rust.
- A bounded repository scan with explicit skip reasons (build output, lockfiles, binaries, secrets, size, depth and
  symlink limits), `.gitignore` and a root `.scopeignore`. Excluded files never reach a Jev request.
- Jev hardening: typed failures with their own exit codes and guidance, batching with bounded concurrency, an explicit
  retry policy, a hard overall deadline, Ctrl-C cancellation, capped candidate code and answer validation. Jev latency
  and token usage are reported on stderr, separately from the artifact.
- An evaluation harness over 26 labeled tasks on five fixture repositories, with frozen held-out labels, Jev
  record/replay, a committed report ([docs/evaluation-report.md](docs/evaluation-report.md)) and an offline release
  gate. On the held-out tasks Scope with Jev finds 75% of the required chunks at 54.6% mean precision and returns 90.6%
  less code than the eligible repository.

### Requirements

- Node 24 or newer on macOS or another Unix. Windows is not supported.
- `TYPESAFE_API_KEY` for the default Jev path. The task and the shortlisted source code are sent to TypeSafe/Jev; see
  the README's "Credentials and data transmission".
