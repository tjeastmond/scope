# Scope

Scope selects the smallest useful code context for a software task.

Give it a task and a local repository. It returns a compact, traceable set of code chunks with source locations and
selection evidence, ready for a developer or coding agent.

```bash
scope "Add retry handling to Stripe webhook processing"
```

## Built around Jev

Scope is a project built around [Jev](https://docs.typesafe.ai), TypeSafe's System One model. Static analysis only
discovers structure and prepares a bounded shortlist of candidate chunks. **Jev makes the relevance decision for every
candidate**, through the official `@typesafe-ai/sdk`. TypeScript then adds the supporting declarations a chunk needs and returns everything relevant, with no size limit.

> Static analysis discovers structure. Jev judges relevance. TypeScript makes the final selection.

`--no-jev` runs a deterministic-only baseline for diagnostics and benchmarks. It is not the primary product path.

## Install

Scope needs **Node 24 or newer** (macOS or another Unix; Windows is not supported). It is not on npm yet, so install it
from a checkout. Building needs [Bun](https://bun.sh):

```bash
git clone https://github.com/tjeastmond/scope.git
cd scope
bun install
bun run build
npm link
```

`npm link` puts `scope` on your PATH, pointing at this checkout, so a later `bun run build` updates it. `npm unlink -g
scope` removes it. Without linking, run `node dist/cli.js "<task>"` from the checkout instead of `scope "<task>"`.

Then set your TypeSafe key (see [Credentials and data transmission](#credentials-and-data-transmission)). To keep it
across shells, add the `export` line to your shell profile (for example `~/.zshenv`), not to a file in a repository:

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key
```

## Quick start

Run Scope from the root of the repository you are working in, or point it at one with `--repo`:

```bash
cd ~/code/my-service
scope "Add retry handling to Stripe webhook processing"
```

Scope scans the repository, shortlists up to 40 candidate chunks, asks Jev which of them matter for the task, and prints
the selected code to stdout. One line of Jev usage goes to stderr, for example:

```text
scope: Jev 260ms, 6259 input / 484 output tokens
```

No key, or no network? `scope "<task>" --no-jev` runs the offline baseline (see [Offline](#credentials-and-data-transmission)).

## Usage

```text
scope "<task>" [--repo <path>] [--format text|markdown|json] [--output <path>] [--no-jev] [--explain]
```

| Flag                | Default           | What it does                                                                                |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `--repo <path>`     | current directory | Repository to analyze                                                                       |
| `--format <format>` | `text`            | `text`, `markdown` or `json`                                                                |
| `--output <path>`   | stdout            | Write the artifact to a file (atomically; it refuses to overwrite a repository source file) |
| `--explain`         | off               | Add selection evidence for every chunk and list every scan warning                          |
| `--no-jev`          | off               | Skip Jev: the offline baseline, no credentials or network                                   |
| `-h`, `--help`      |                   | Show help                                                                                   |

Only the artifact goes to stdout (or the `--output` file). Warnings, Jev usage and the final `wrote` line go to stderr,
so piping is safe. There is no token budget: Scope returns everything Jev finds relevant.

### Examples

```bash
# Plain text to read in the terminal (the default).
scope "Add retry handling to Stripe webhook processing"

# Markdown to paste into an issue, a PR or a chat with a coding agent.
scope "Add retry handling to Stripe webhook processing" --format markdown --output context.md

# JSON for tools and agents: every region with file, line range, chunks and code.
scope "Add retry handling to Stripe webhook processing" --format json | jq '.regions[] | .file'

# Why was each chunk chosen? Adds retrieval signals, Jev's relevance, score, origin and inclusion reason.
scope "Add retry handling to Stripe webhook processing" --explain

# Another repository, offline.
scope "Add retry handling to Stripe webhook processing" --repo ../webhook-service --no-jev
```

Each format is described field by field in [docs/output-formats.md](docs/output-formats.md). The JSON carries a
`schemaVersion`, plus `retrievalConfigVersion` and `jevQuestionVersion` so a result can be traced to the code and
question wording that produced it.

## Languages

Every text file is eligible. How finely Scope can cut it depends on the language:

| Level          | Languages (extensions)                                                              | Chunks                                                                                           |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Semantic**   | TypeScript and JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python (`.py`) | Functions, classes, methods, types, interfaces and exports, with import references for the graph |
| **Structural** | SQL, HTML, CSS, SCSS, JSON/JSONC, YAML, TOML, Markdown                              | Statements, elements, rules, top-level keys and Markdown sections                                |
| **Text**       | Go, Java, Rust, and other text files (`.txt`, `.xml`, `.ini`, `.conf`, ...)         | Windows of about 80 lines (at most 100), cut at blank lines where possible                       |

Known limitations:

- **Go, Java and Rust have no parser yet.** They are chunked as text windows, so there are no symbol names or import
  edges, and a window can split a function. Retrieval still matches their text and paths, and Jev still judges them.
- **The dependency graph is import-only and local.** No call, type or inheritance edges; no tsconfig `paths` aliases,
  package `exports` or workspaces; no cross-language links. Details: [docs/graph-limitations.md](docs/graph-limitations.md).
- **A file with syntax errors is still analyzed:** chunks come from the parseable regions, with a warning. JSONC (JSON
  with comments) is parsed leniently, also with a warning.
- **Skipped entirely:** gitignored paths, dependency and build directories, secret-looking files, binary files, and
  lockfile, minified or oversized files. Each skip is reported as a warning with its reason.
- **The shortlist is 40 candidates.** Code that retrieval does not shortlist cannot be selected, however relevant. On
  the held-out benchmark tasks Scope finds 75% of the required chunks (see [Benchmarks](#benchmarks)).

## Credentials and data transmission

**What is sent.** The ordinary command (`scope "<task>"`) sends two things to TypeSafe/Jev through the official SDK:
the task text and, for each shortlisted candidate chunk (at most 40 functions, classes, methods, types), its source
code plus metadata: repository-relative path, symbol name, kind and line range. Nothing else from your repository is
sent.

Each candidate's code is cut to its first 6,000 characters for judging, with a `[truncated for judging: showed N of M
characters]` line marking the cut; the selected output still contains the full chunk. Results carry `jevQuestionVersion`, naming the question wording used.

Candidates are judged in requests of at most 16 questions, up to 4 at a time. If any request fails, the whole run
fails; Scope never returns a partial result.

**Time limits.** Each request attempt times out after 30 seconds. The SDK retries a failed attempt at most twice (HTTP
408, 429 and 5xx, connection errors and timeouts), waiting at most 10 seconds between attempts. Scope adds no retries
of its own. All Jev requests of a run share a 90-second overall deadline (`JEV_DEADLINE_MS` in `src/config.ts`): past
it, the run fails with `Jev unavailable: ... deadline` and stdout stays empty.

**Audit the payload.** `SCOPE_JEV_PAYLOAD=print` makes Scope scan and shortlist as usual, then print the exact request
bodies it would send (a JSON array, one element per request, each with its `state`, `questions` and `model`) to stdout
and exit 0. The model is `TYPESAFE_DEFAULT_MODEL` if set, otherwise `jev-latest`. Nothing is sent and no key is needed.
It cannot be combined with `--no-jev` or `--output`.

```bash
SCOPE_JEV_PAYLOAD=print scope "Add retry handling to Stripe webhook processing" > payload.json
```

**What is never sent.** Files matched by `.gitignore` (root and nested), dependency and build directories, and files
with secret-looking names (`.env`, `.env.*`, `*.pem`, `*.key`, `*secret*`, `*credential*`) are never read. Files containing
binary data are never parsed or sent. Credential-looking text inside source (private key blocks, common API token
shapes, quoted values assigned to `apiKey`/`secret`/`token`/`password`) is replaced with `[REDACTED]` before parsing.
Redaction is best-effort: do not rely on it to protect secrets you have committed to source.

To keep more paths out without touching `.gitignore`, add a `.scopeignore` at the repository root (gitignore syntax;
root only). Matches are skipped with the reason `scopeignore`. It can only subtract: a `!` negation never re-includes a
secret, a `.gitignore`d path or a dependency/build directory.

```gitignore
# .scopeignore
fixtures/
docs/generated/
```

**Credentials.** Set `TYPESAFE_API_KEY` in the environment. Scope reads it only to create the SDK client. It is never
printed, logged, written to disk or included in error messages.

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key
scope "Add retry handling to Stripe webhook processing"
```

**Offline.** `--no-jev` needs no key and makes no network calls. It scores every candidate equally, so it is a
diagnostic baseline, not a replacement for Jev's relevance judgment.

**Warnings.** Per-file scan warnings (syntax errors, files with no extracted chunks, JSONC, text fallbacks) print as a
single line on stderr with a count per kind; `--explain` lists each one. The artifact always carries every warning.

**Failures.** If Jev cannot complete, Scope fails; it never falls back to offline results. Stdout stays empty, the error
goes to stderr, and the exit code says what failed. A Jev failure prints two lines: the labelled message, then one line of
setup or retry guidance that also names `--no-jev` as the offline baseline you can choose instead (Scope never switches
to it on its own).

| Exit code | Meaning                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| 0         | Success                                                                                                    |
| 1         | Any other failure (for example an unwritable `--output`, or an unexpected error)                           |
| 2         | Usage error (bad argument, `--repo` is not a directory)                                                    |
| 3         | `Jev unavailable:` the key is missing (`TYPESAFE_API_KEY` is not set) or Jev rejected it (HTTP 401 or 403) |
| 4         | `Jev unavailable:` rate limited (HTTP 429)                                                                 |
| 5         | `Jev unavailable:` a request attempt or Scope's overall deadline timed out                                 |
| 6         | `Jev unavailable:` Jev failed or could not be reached (HTTP 5xx, other HTTP errors, network errors)        |
| 7         | `Jev returned an unusable response:` missing, duplicate or out-of-range answers                            |
| 8         | `Jev request not sent:` a request too large for Jev's limits                                               |
| 130       | `Cancelled:` interrupted with Ctrl-C (128 + SIGINT); stdout stays empty and no guidance line is printed    |

## Benchmarks

Scope is measured on 26 labeled tasks over five fixture repositories (TypeScript, Python, React, a mixed
TypeScript/Python/SQL app, and a snapshot of Scope itself). The committed report is
[docs/evaluation-report.md](docs/evaluation-report.md). On the held-out tasks, which were labeled and frozen before
tuning, Scope with Jev finds 75% of the required chunks with 54.6% mean precision and returns 90.6% less code than the
eligible repository. The offline baseline finds 80% of the required chunks at 11.9% precision.

Reproduce it from a checkout (after `bun install`):

```bash
# Offline: replay the committed Jev recording, regenerate the report and check every release gate.
bun run eval:report
bun run eval:gate

# Offline baselines only (lexical BM25 and --no-jev), written to eval-results/.
bun run eval

# Live: Jev mode on every task (needs TYPESAFE_API_KEY), saved as the recording the report replays.
bun run eval --mode jev --split all --record eval-recordings/jev-baseline.json
bun run eval:report
```

`bun run eval:report --check` exits 1 if the committed report differs from what the recording produces. Before running
the held-out split after a label change, freeze the labels with `bun run eval:freeze`. The labeling guide, metrics,
split rules and gate thresholds are in [docs/evaluation.md](docs/evaluation.md).

## Status

V1, not yet published to npm. The design, contracts and milestones are in
[docs/scope-implementation-plan.md](docs/scope-implementation-plan.md).

## Development

Bun is used for tooling and tests; the compiled CLI targets Node 24+ and uses no Bun APIs.

```bash
bun install
bun run validate   # format check, lint, typecheck, build, tests and the offline evaluation gate
```

`bun run format` rewrites files with Prettier. Tests never call Jev; live Jev runs need `TYPESAFE_API_KEY`.
`bun run smoke:node` installs the packed CLI into a temporary directory and runs it on real Node (set `SCOPE_NODE` to a
Node binary; it needs network for `npm install`).
