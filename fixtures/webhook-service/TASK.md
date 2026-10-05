# Fixture task: webhook-service

Task: `Add retry handling to Stripe webhook processing`

This fixture is source data only. It is never executed, type-checked, linted or formatted by the Scope repository.
Chunk names are `path::symbol`, relative to `fixtures/webhook-service/`. The names are stable; do not rename them.

## Required

The change cannot be made correctly without these chunks.

| Chunk                                 | Why                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `src/stripe/handler.ts::processEvent` | Dispatches events to the billing calls that need retrying.              |
| `src/util/retry.ts::withRetry`        | The existing retry helper to wrap the billing calls with.               |
| `src/util/retry.ts::computeBackoff`   | Backoff calculation used by `withRetry`; needed to reason about delays. |
| `src/util/retry.ts::RetryOptions`     | Options type that the new call sites must supply.                       |

## Useful

Helpful context, but the change can be made without them.

| Chunk                                                 | Why                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `src/stripe/handler.ts::handleStripeWebhook`          | Entry point; shows idempotency handling around `processEvent`. |
| `src/stripe/handler.ts::markInvoicePaid`              | Failing billing call that should be retried.                   |
| `src/stripe/handler.ts::cancelSubscription`           | Failing billing call that should be retried.                   |
| `src/stripe/types.ts::WebhookResult`                  | Result shape returned after retries are exhausted.             |
| `tests/handler.test.ts::checkRejectsInvalidSignature` | Existing test to extend with retry coverage.                   |

## Irrelevant

Not needed for this task.

| Chunk                                             | Note                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/webhooks/signature.ts::verifySignature`      | Shares the word "webhook" but has nothing to do with retries.            |
| `src/webhooks/signature.ts::parseSignatureHeader` | Same.                                                                    |
| `src/stripe/types.ts::StripeEvent`                | Event shape; unchanged by retries.                                       |
| `src/email/sender.ts::sendWithRetry`              | Near-miss: "retry" in its name, but a separate helper used only by email. |
| `src/email/sender.ts::deliver`                    | Email transport.                                                         |
| `src/email/format.ts::format`                     | Same name as `src/dates/utils.ts::format`.                               |
| `src/dates/utils.ts::format`                      | Same name as `src/email/format.ts::format`.                              |
| `src/dates/utils.ts::addDays`                     | Date utility.                                                            |
| `src/users/profile.ts::renderProfile`             | User profile rendering.                                                  |
| `src/users/profile.ts::UserProfile`               | Profile type.                                                            |
| `src/logger.ts::Logger`                           | Logging class; its methods `info`, `warn` and `error` are also chunks.   |

## Design notes

- Near-miss: `sendWithRetry` in `src/email/sender.ts` is lexically close to the task but is used only by the email sender.
- Name collision: `format` exists in both `src/email/format.ts` and `src/dates/utils.ts`.
