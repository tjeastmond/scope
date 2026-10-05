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
candidate**, through the official `@typesafe-ai/sdk`. TypeScript then applies cost, coherence, and the token budget.

> Static analysis discovers structure. Jev judges relevance. TypeScript makes the final selection.

`--no-jev` runs a deterministic-only baseline for diagnostics and benchmarks. It is not the primary product path.

## Credentials and data transmission

**What is sent.** The ordinary command (`scope "<task>"`) sends two things to TypeSafe/Jev through the official SDK:
the task text and, for each shortlisted candidate chunk (at most 30 functions, classes, methods, types), its source
code plus metadata: repository-relative path, symbol name, kind and line range. Nothing else from your repository is
sent.

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
goes to stderr, and the exit code is non-zero:

| Exit code | Meaning                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Success                                                                                                                                                                                                                                                        |
| 1         | Runtime failure. The message starts with `Jev unavailable:` (missing key, 401/403, 429, network, timeout), `Jev returned an unusable response:` (missing, duplicate or out-of-range answers) or `Jev request not sent:` (a request too large for Jev's limits) |
| 2         | Usage error (bad argument, `--repo` is not a directory)                                                                                                                                                                                                        |

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
