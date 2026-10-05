# M1 live Jev run

Three real runs of the compiled CLI against the fixture, with TJ's `TYPESAFE_API_KEY` (not recorded here). SDK `@typesafe-ai/sdk` 0.6.0, Node 24, run 2026-10-05.

```bash
node dist/cli.js "Add retry handling to Stripe webhook processing" --repo fixtures/webhook-service
```

## Result

Jev changed the result. The `--no-jev` baseline keeps all 26 candidates; Jev kept 12, 13 and 14 in the three runs. The stable core is the retry code, the webhook handler path and the types they use. Distractors such as `email/sender.ts` (`sendWithRetry`, a retry for email), both `format` functions, `addDays`, `renderProfile` and the tests were never selected.

| Run | Latency | Input tokens | Output tokens | Chunks kept |
| --- | ------- | ------------ | ------------- | ----------- |
| 1   | 312 ms  | 5536         | 462           | 13          |
| 2   | 305 ms  | 5536         | 462           | 12          |
| 3   | 243 ms  | 5536         | 462           | 14          |

Relevance by chunk (blank = not selected, so scored below the 0.5 minimum):

| Chunk                  | Run 1 | Run 2 | Run 3 |
| ---------------------- | ----- | ----- | ----- |
| `handleStripeWebhook`  | 0.94  | 0.94  | 0.94  |
| `processEvent`         | 0.87  | 0.87  | 0.87  |
| `withRetry`            | 0.86  | 0.86  | 0.84  |
| `markInvoicePaid`      | 0.86  | 0.84  | 0.84  |
| `cancelSubscription`   | 0.85  | 0.85  | 0.85  |
| `RetryOptions`         | 0.84  | 0.82  | 0.83  |
| `computeBackoff`       | 0.80  | 0.80  | 0.80  |
| `StripeEvent`          | 0.71  | 0.74  | 0.72  |
| `Logger` (class)       | 0.66  | 0.64  | 0.66  |
| `verifySignature`      | 0.64  | 0.56  | 0.63  |
| `WebhookResult`        | 0.64  | 0.59  | 0.62  |
| `Logger.warn`          | 0.52  | 0.51  | 0.52  |
| `parseSignatureHeader` | 0.52  |       | 0.52  |
| `Logger.error`         |       |       | 0.51  |

## Observations

- **Variability.** Scores move by up to about 0.08 between runs of identical input (`verifySignature` 0.56–0.64) and the eight chunks scoring 0.7 or more were the same in every run. Chunks scoring 0.51–0.52 flip in and out (`parseSignatureHeader`, `Logger.error`), so the selected set is not reproducible at the 0.5 minimum. A Noul near 0.5 means roughly equal odds of yes and no, so those chunks are uncertain, not weakly relevant. Choosing a threshold belongs to #63 (tuning tasks), not to one fixture.
- **Overlap.** `Logger` (lines 1-15) already contains `Logger.warn` and `Logger.error`, so the same lines are sent twice. Tracked in #33 and #50.
- **Usage** is identical across runs because the request is deterministic; the token cost of one fixture run is about 6k tokens.
- **Limits of this evidence.** The CLI does not print scores for chunks below the minimum, so their values are only known to be under 0.5. Printing every candidate's score belongs with `--explain` (#55). Three runs on one small fixture show the integration works and give a first view of variability; they say nothing about quality on a real repository (see #91 and M7).
