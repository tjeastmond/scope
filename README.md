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

## Credentials and data transmission

**What is sent.** The ordinary command (`scope "<task>"`) sends two things to TypeSafe/Jev through the official SDK:
the task text and, for each shortlisted candidate chunk (at most 30 functions, classes, methods, types), its source
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

**Credentials.** Set `TYPESAFE_API_KEY` in the environment. Scope reads it only to create the SDK client. It is never
printed, logged, written to disk or included in error messages.

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key
scope "Add retry handling to Stripe webhook processing"
```

**Offline.** `--no-jev` needs no key and makes no network calls. It scores every candidate equally, so it is a
diagnostic baseline, not a replacement for Jev's relevance judgment.

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

## Local cache (`.scope/`)

Scope keeps derived data in `.scope/` at the repository root. It creates `.scope/.gitignore` so git ignores the
directory, and it never edits your own `.gitignore`. You can delete the directory at any time; Scope rebuilds what it
needs on the next run. Cached entries are signed with a random per-user key that Scope creates at
`~/.local/state/scope/cache-key` (or under `$XDG_STATE_HOME`), outside any project, so a cache planted in a repository
is never trusted. `--no-cache` (or `SCOPE_CACHE=off`) makes a run neither read nor write it.

Three commands control the store (none needs a task, Jev or credentials):

```bash
scope cache status  [--repo <path>] [--format text|json]   # size, entries, versions, last update, retention bounds
scope cache clear   [--repo <path>] --yes                  # delete everything Scope stored in .scope/
scope cache rebuild [--repo <path>]                        # reanalyze every file and rewrite the analysis cache
```

`status` is read-only and creates nothing. `clear` has no prompt: it needs `--yes`, never follows a symlinked `.scope/`
or store directory, deletes only Scope's own files inside `.scope/` (files it did not create are left and reported)
and never touches the integrity key. `rebuild` rewrites analysis data only (unless the cache is stale, from another root or Scope version, which resets
the whole store as any run does); `clear` removes everything. To run a task
that is literally the word `cache`, write `scope -- cache`.

Retention bounds for the data later features keep are shown by `status` and can be set with `SCOPE_HISTORY_MAX_RUNS`
(default 200), `SCOPE_HISTORY_MAX_DAYS` (90), `SCOPE_DECISIONS_MAX` (500), `SCOPE_DECISIONS_MAX_DAYS` (7),
`SCOPE_FEEDBACK_MAX` (2000) and `SCOPE_FEEDBACK_MAX_DAYS` (365). Each takes a whole number from 0 (keep none) up to
10 times its default; an invalid value is ignored with a warning.

## Status

Early development. See [docs/scope-implementation-plan.md](docs/scope-implementation-plan.md).

## Development

Bun is used for tooling; the compiled CLI targets Node 24+.

```bash
bun install
bun run format
bun run typecheck
bun test
```

Jev calls need `TYPESAFE_API_KEY` in the environment.
