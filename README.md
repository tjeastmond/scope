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
