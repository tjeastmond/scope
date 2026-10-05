# M1 live Jev run: blocked

**Status: blocked. The live run has not been done.** `TYPESAFE_API_KEY` was not available when M1 was built, so Scope has not been run against the real Jev API. Issue #13 stays open.

## What this means

Everything that touches Jev is verified only against a fake provider and a fake SDK client:

- Request shape: one Noul per candidate, batched on the serialized request (`src/jev/provider.ts`), built from the installed `@typesafe-ai/sdk` 0.6.0 types and the live docs (`docs/jev-sdk-notes.md`).
- Response validation, failure labels, exit codes, empty stdout on failure and key redaction (`tests/jev-provider.test.ts`, `tests/validate.test.ts`, `tests/cli.test.ts`).
- Unverified against the real service: whether the Noul wording and criteria separate relevant from irrelevant code, the relevance values Jev returns for the fixture, latency, usage, rate limits and the 10 s SDK timeout in practice.

## Checked offline (Node v24.7.0, compiled `dist/cli.js`)

```bash
node dist/cli.js "Add retry handling to Stripe webhook processing" --repo fixtures/webhook-service
```

With no key: exit code 1, empty stdout, and on stderr:

```
scope: Jev unavailable: TYPESAFE_API_KEY is not set. Set it to run Scope with Jev, or pass --no-jev for the offline baseline.
```

With `--no-jev` the same task selects all 26 fixture candidates (every candidate scores 1), which is the all-candidates baseline a Jev run should narrow.

## To complete this

With a key in the environment:

```bash
bun run build
SCOPE_LIVE_JEV=1 bun test tests/live-jev.test.ts   # contract test; prints usage
node dist/cli.js "Add retry handling to Stripe webhook processing" --repo fixtures/webhook-service
```

Repeat the CLI run a few times, then replace this file with: the task, per-candidate relevance values, the selected chunks, latency, usage, SDK version, date and the command, plus the chunks Jev kept out compared with the 26-candidate baseline and any run-to-run variability. Redact anything credential-like first. Then check off each M1 acceptance criterion in #13 before closing it.
