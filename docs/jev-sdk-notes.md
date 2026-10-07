# Jev SDK integration notes

Facts the Scope Jev adapter depends on (issue #2, milestone M1; re-verified and measured live for issue #58, milestone M5).

## Basis and verification status

- **SDK:** `@typesafe-ai/sdk` **0.6.0** (`VERSION = "0.6.0"`), read from `node_modules/@typesafe-ai/sdk/dist/index.d.mts`. Quoted types below are copied from that file.
- **Docs read (2026-10-05):** [llms.txt index](https://docs.typesafe.ai/llms.txt), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md), [JS SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), [Primitives](https://docs.typesafe.ai/primitives.md), [State](https://docs.typesafe.ai/concepts/state.md), [Confidence](https://docs.typesafe.ai/confidence.md), [HTTP API](https://docs.typesafe.ai/api.md), [Models](https://docs.typesafe.ai/models.md), [Re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).
- **Re-verified 2026-10-07 (M5, issue #58):** 0.6.0 is still the latest published version (`npm view @typesafe-ai/sdk`; the changelog lists only 0.5.7 and 0.6.0, and 0.6.0's only breaking change concerns `Score.criteria`, which Scope does not use). The docs pages above were re-read and state the same limits, pricing and retry behavior. No SDK bump.
- **Live measurements (2026-10-07):** taken with TJ's key by `bun scripts/measure-jev.ts` against `jev-1.13.0`; see [Measured behavior](#measured-behavior-2026-10-07). Names and types are checked against the installed SDK by `bun run typecheck`, which includes the scripts. Items still marked **unverified** below could not be measured safely.
- `scripts/spike-jev.ts` is the original M1 throwaway that sends 3 Noul questions and prints the raw response. Without the key it prints a message and exits 0.

## Client construction and authentication

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY
const explicit = new TypeSafeClient({ apiKey, timeout: 30_000 });
```

- `new TypeSafeClient(config?: TypeSafeClientConfig)`. `apiKey` falls back to env `TYPESAFE_API_KEY`; empty or whitespace-only env values are ignored. A missing key throws `TypeSafeError` from the constructor.
- Other env fallbacks (`ENV` export): `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`), `TYPESAFE_LOG_LEVEL` (default `warn`). Explicit options win over env.
- HTTP wire format (docs): `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`.
- SDK docs state Node.js 20+; ESM, CommonJS and declarations are shipped. Scope targets Node 24+.
- **Logging hazard:** `logLevel: "debug"` logs request headers and bodies. Credential headers are only partly redacted (a review reproduced the key's last four characters appearing in `debug` output), and **bodies are not redacted** at all (they contain source code). Scope must not enable `debug`/`info` logging by default, and should set `logLevel` explicitly rather than inherit `TYPESAFE_LOG_LEVEL`.

## Noul helper and question shape

```ts
declare const noul: (instructions?: EntryType, criteria?: NoulQuestion["criteria"]) => NoulQuestion;

interface NoulQuestion {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
}
type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null;
```

- `instructions` is a string, a JSON object, or an array. An object may hold the question in one field and data in others, referenced by name in backticks (HTTP API docs, "Noul").
- `criteria.true` / `criteria.false` are optional descriptions of what yes and no mean.
- Sibling helpers `choice(instructions, criteria)` and `score(instructions, criteria)` exist but Scope only needs `noul`.
- **Question ids are not sent to the model** (HTTP API, Noul and Primitives docs). Each question's `instructions` must name its candidate explicitly (for example by a reference string that also appears in the state or in the instructions object). Docs also say to write the complete question in `instructions` even when the id looks self-explanatory.
- Docs guidance: one yes/no per Noul, phrase so high means yes, a Noul is the probability of yes and not a degree scale, use `criteria` when the boundary is subtle, ask many Nouls per request (they are evaluated in parallel against one state).

## `systemOne` request and response

```ts
systemOne<const Q extends Questions>(request: SystemOneRequest<Q>, options?: RequestOptions): APIPromise<SystemOneResult<Q>>;

interface SystemOneRequest<Q extends Questions = Questions> {
  state: EntryType;     // text, JSON object or array, or null
  questions: Q;         // nonempty, keyed by caller-chosen names
  model?: string;       // inherits client defaultModel ("jev-latest")
}

interface SystemOneResult<Q extends Questions> {
  readonly model: string;                              // e.g. "jev-1.13.0" in the docs' examples
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  readonly usage: Usage;
}

interface NoulResponse {
  readonly type: "noul";
  /** Probability of a yes answer, from zero to one. */
  readonly noul: number;
}

interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}
```

- **The probability lives at `response.answers[<id>].noul`**, a number documented as 0 to 1 (0 = no, 1 = yes). It is the probability of yes. Noul answers carry **no** `confidence` field (Confidence and Noul docs); Choice and Score answers do.
- Example response (docs): `{ "model": "jev-1.13.0", "answers": { "is_urgent": { "type": "noul", "noul": 0.95 } }, "usage": { "input_tokens": 296, "output_tokens": 20 } }`.
- Usage fields are snake_case: `usage.input_tokens`, `usage.output_tokens`. Pricing (Models doc): charged per input token; output tokens are free.
- `systemOne` throws `TypeSafeError` (before any request) when `questions` is empty.
- `APIPromise` also offers `.withResponse()` (`{ data, response, requestId }`, request id from header `x-typesafe-request-id`), `.asResponse()` and `.map()`.
- **Observed at runtime:** every submitted id came back with a `noul` in [0, 1] in every measured request (up to 1000 questions), and the model was `jev-1.13.0`. That is evidence, not a guarantee; Scope still validates (finite, in range, one per candidate) and treats violations as a Jev failure.

## Request limits

Documented (Models page, `jev-1.13.0`):

| Limit                                    | Value                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Context per request                      | 64k tokens covering `state` plus **all** questions combined                                                          |
| `state` plus the single longest question | 32k tokens                                                                                                           |
| Rate limits                              | 100K tokens per second and 80 requests per second; over either limit returns `429`. Stated to change without notice. |
| Input type                               | Text only (string, JSON object, array of text values)                                                                |
| Choice options / Score levels            | 255 options max per Choice; Score API accepts up to 10 levels (not relevant to Noul)                                 |

- **Maximum questions per request: not documented**, and the SDK enforces no client-side maximum (only non-empty). Measured: 1000 short Nouls in one request were all answered (19,165 input tokens, about 0.4 s). No count limit was found below the token limits, so the token limits are the binding bound.
- **Maximum payload size in bytes: not documented.** Jev's limits are expressed in its own tokens, which Scope does not compute. The adapter bounds each request by serialized characters (`JEV_BATCH_MAX_CHARS`) instead. Measured: an oversize request fails with **HTTP 400** (`BadRequestError`, body `{"detail":{"error_type":"max_tokens_exceeded"}}`), not 422, both for a large `state` and for many long questions. 400 is not in the SDK's retried statuses, so it fails on the first attempt.
- Because the `state` is ingested once and all questions are evaluated against it, a per-candidate state is not required: one shared state (task plus candidates) with one Noul per candidate fits the batching model. The re-ranking cookbook instead sends one request per query-candidate pair; both are valid shapes. Quality differences for Scope remain **unverified** (measuring them needs labeled tasks; see issue #63).
- Jaggedness doc: accuracy degrades with large states full of irrelevant detail ("Filter first; send only what the question needs"), and the model reads questions literally.

## Timeouts, retries and cancellation

```ts
interface RequestOptions {
  signal?: AbortSignal; // cancels the request and pending retries
  timeout?: number; // per attempt in ms; no total retry budget
  retry?: Partial<RetryPolicy>;
  headers?: Record<string, string>;
}

interface RetryPolicy {
  maxRetries: number; // default 2; 0 disables
  backoffInitialMs: number; // default 500, doubled up to backoffMaxMs
  backoffMaxMs: number; // default 5000
  backoffJitter: number; // default 0.25
  httpStatuses: ReadonlySet<number>; // default 408, 429, 500-599
  respectRetryAfter: boolean; // default true (Retry-After, retry-after-ms)
  maxRetryAfterMs: number; // default 60000
  apiConnectionError: boolean; // default true
  apiTimeoutError: boolean; // default true
}
```

- Client-level `timeout` default is **10000 ms per attempt** (constructor option `timeout`; overridable per call). With the default 2 retries the worst case is roughly 3 attempts plus backoff; there is no overall deadline, so Scope must apply its own total deadline through an `AbortSignal` (for example `AbortSignal.timeout(ms)`).
- The timeout covers the full response including body delivery. Measured attempts took 0.12 to 0.35 s, including a 62k-character, 25-question request, so Scope's 30 s per-attempt timeout (`JEV_ATTEMPT_TIMEOUT_MS`) leaves about 100x headroom.
- Cancellation: pass `signal` in the second argument. Abort rejects with `APIUserAbortError` (also during backoff waits).
- Retries and timeouts can be set at construction (`retry`, `timeout`) and overridden per call.

## Error classes

All extend `TypeSafeError extends Error`.

| Class                      | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `TypeSafeError`            | Base class; also thrown for missing API key, invalid config, empty `questions`   |
| `APIError`                 | Non-2xx response. Fields: `status`, `headers`, `body`, `requestId`               |
| `BadRequestError`          | 400                                                                              |
| `AuthenticationError`      | 401 (missing or invalid key)                                                     |
| `PermissionDeniedError`    | 403                                                                              |
| `NotFoundError`            | 404                                                                              |
| `UnprocessableEntityError` | 422 (validation failure)                                                         |
| `RateLimitError`           | 429; extra field `retryAfterMs: number \| undefined`                             |
| `InternalServerError`      | 5xx (docs also list `529 Overloaded`, retried by default as a 5xx)               |
| `APIConnectionError`       | Connection failure or interrupted body (extends `TypeSafeError`, not `APIError`) |
| `APITimeoutError`          | Extends `APIConnectionError`; field `timeoutMs`                                  |
| `APIUserAbortError`        | Caller aborted through `AbortSignal` (extends `TypeSafeError`)                   |

Mapping of HTTP status to class is from the installed type doc comments. Observed at runtime: 400 → `BadRequestError` (token limit), a 1 ms per-attempt timeout → `APITimeoutError`, an aborted signal → `APIUserAbortError`. 401, 403, 429 and 5xx were not provoked.

## Facts Scope's adapter will rely on

Names, signatures and option fields below come from the installed 0.6.0 types; variables such as `task`, `candidates`, `path` are illustrative placeholders. `scripts/spike-jev.ts` typechecks the client, `noul`, `systemOne`, `signal` and error-class usage.

```ts
import { APIConnectionError, APIError, APIUserAbortError, TypeSafeClient, TypeSafeError, noul } from "@typesafe-ai/sdk";

// 1. Client: key from TYPESAFE_API_KEY, logging not left to env, per-attempt timeout.
const client = new TypeSafeClient({ logLevel: "off", timeout: 30_000, retry: { maxRetries: 2 } });

// 2. One Noul per candidate. The id is for code only; the instructions name the candidate.
const questions = {
  c1: noul({ question: "Is candidate `c1` needed for the task in `task`?", task, c1: { path, symbol, code } }),
};

// 3. One request, with caller-owned cancellation/deadline.
const result = await client.systemOne(
  { state: { task, candidates }, questions },
  { signal: AbortSignal.timeout(60_000) },
);

// 4. Relevance utility and usage.
const relevance: number = result.answers.c1.noul; // probability of yes, documented 0..1
const { input_tokens, output_tokens } = result.usage;
const modelUsed: string = result.model;

// 5. Failure handling: any of these must fail the default run, never fall back.
//    APIError (.status, .requestId), APIConnectionError / APITimeoutError, APIUserAbortError, TypeSafeError.
```

Adapter obligations that follow from the above:

1. Validate every answer: present for each submitted id, `type === "noul"`, finite, within [0, 1]; otherwise fail clearly.
2. Never rely on the question id inside the model; put an explicit candidate reference in each question.
3. Size batches by serialized characters (`JEV_BATCH_MAX_CHARS`), kept conservative (about one token per character at most for ordinary text) against the 64k combined and 32k state-plus-longest-question limits, without a guarantee for every Unicode input; there is no documented question-count or byte limit. A single candidate that cannot fit one request with the task fails the run (`JevRequestError`).
4. Own the overall deadline with `AbortSignal`; the SDK only has a per-attempt timeout.
5. Do not log request bodies; never print or persist the API key.
6. Record `usage` and latency per request for the M1 prototype evidence.

## Measured behavior (2026-10-07)

`bun scripts/measure-jev.ts`, SDK 0.6.0 under Bun 1.3.14, model `jev-1.13.0`, retries disabled so every number is one attempt. Candidates are chunks of this repository's `src/` (redacted by the normal pipeline), judged with Scope's own question shape (`JevDecisionProvider`). Each scenario ran three times; token counts were identical across repeats.

| Scenario (25 candidates)                    | Requests | Serialized chars     | Input tokens        | Output tokens | End-to-end latency |
| ------------------------------------------- | -------- | -------------------- | ------------------- | ------------- | ------------------ |
| Retrieval shortlist, one request            | 1        | 24,306               | 7,407               | 444           | 185–265 ms         |
| Retrieval shortlist, default batching (24k) | 2        | 23,733 + 715         | 7,229 + 470 = 7,699 | 448           | 289–533 ms         |
| 25 largest `src/` chunks, one request       | 1        | 62,253               | 17,545              | 444           | 268–293 ms         |
| 25 largest `src/` chunks, default batching  | 3        | 23,410+23,360+15,767 | 18,129              | 452           | 605–642 ms         |

State size sweep (one short question, code-only state):

| State chars | Result                                     |
| ----------- | ------------------------------------------ |
| 60,000      | accepted, 16,832 tokens (3.56 chars/token) |
| 90,000      | accepted, 25,214 tokens                    |
| 110,000     | accepted, 30,662 tokens (3.59 chars/token) |
| 130,000     | HTTP 400 `max_tokens_exceeded`             |

Other observations:

- **Tokens per character:** serialized requests (JSON, metadata, questions and TypeScript source) measured 3.28 to 3.59 characters per token. A request with almost no code is denser (715 chars → 470 tokens) because each request carries a fixed overhead of roughly 250 tokens.
- **Output tokens:** about 18 per Noul (444 for 25), and output is not billed.
- **Cost:** at the documented $0.042 per million input tokens, the 25-candidate shortlist request costs about $0.0003. Pricing is from the Models page on 2026-10-07 and can change; Scope does not report money.
- **Latency:** dominated by the per-request round trip, not by payload size or question count (1000 questions took about 0.4 s). Batches run sequentially today, so each extra batch adds about 0.15 to 0.35 s.
- **Determinism:** identical requests returned identical token counts, but relevance near the 0.5 threshold varied slightly between runs, so the count of candidates kept varied by one or two (7–9 for the shortlist). This matches the M1 and M2 live runs.
- **Cancellation and retries:** a 1 ms per-attempt timeout with `maxRetries: 0` fails with `APITimeoutError`; aborting the signal after 5 ms fails with `APIUserAbortError`. With the default 2 retries and 1 ms timeouts, the call failed after 1.4 s, consistent with the documented backoff (500 ms then 1000 ms, ±25% jitter).
- **Not provoked:** 401/403 (would need a bad key), 429 (would need deliberately exceeding the rate limit) and 5xx. Their mapping is taken from the SDK types.

## Discrepancies from M1 assumptions

1. **Characters per token.** M1 assumed "about one token per character at most for ordinary text". Measured code and JSON payloads run about 3.3 to 3.6 characters per token, so the 24,000-character batch cap (`JEV_BATCH_MAX_CHARS`) is about 7,000 to 7,500 tokens, roughly a quarter of the 32k state-plus-longest-question limit. A typical 25-candidate shortlist (about 24k characters) lands just over the cap and is split into two requests, paying extra latency and about 250 overhead tokens per extra request. The one-token-per-character bound still holds as a worst case for unusual Unicode, so any change to the cap belongs to the batching work in issue #62, with that trade-off stated.
2. **Oversize status.** M1 expected 422 `UnprocessableEntityError` for limit violations; Jev returns **400** `BadRequestError` with `error_type: "max_tokens_exceeded"`. Scope's failure message currently reports only "HTTP 400"; issue #64 should give it an actionable message.
3. **Timeout needs.** M1 left open whether large batches need more than 10 s per attempt. Measured attempts are under 0.4 s; the 30 s attempt timeout and 90 s overall deadline (`JEV_DEADLINE_MS`) are generous rather than tight. Issue #65 owns the worst-case bound.
4. **Question count.** No limit was found up to 1000 questions per request, so batching by question count is not needed for Scope's 20 to 30 candidate shortlists.

## Unverified items

- Quality difference between a shared-state batch and one request per candidate (needs labeled tasks; issue #63).
- Error classes for 401, 403, 429 and 5xx at runtime (taken from the SDK types; provoking them needs a bad key or deliberate rate-limit abuse).
- Effective rate limits (documented as changing without notice; not exercised).
- Exactly where the 64k combined limit begins (a request with many long questions, estimated well above 64k tokens, was rejected with `max_tokens_exceeded`; the boundary was not swept).
