# Jev SDK integration notes

Facts the Scope Jev adapter depends on (issue #2, milestone M1).

## Basis and verification status

- **SDK:** `@typesafe-ai/sdk` **0.6.0** (`VERSION = "0.6.0"`), read from `node_modules/@typesafe-ai/sdk/dist/index.d.mts`. Quoted types below are copied from that file.
- **Docs read (2026-10-05):** [llms.txt index](https://docs.typesafe.ai/llms.txt), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md), [JS SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), [Primitives](https://docs.typesafe.ai/primitives.md), [State](https://docs.typesafe.ai/concepts/state.md), [Confidence](https://docs.typesafe.ai/confidence.md), [HTTP API](https://docs.typesafe.ai/api.md), [Models](https://docs.typesafe.ai/models.md), [Re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).
- **Live verification is BLOCKED.** `TYPESAFE_API_KEY` was not available in this environment, so no request was sent to Jev. Every statement about runtime behavior is marked **unverified** below. What _is_ verified is: names and types (compiled against the installed SDK by `bun run typecheck`, which includes `scripts/spike-jev.ts`) and what the docs state.
- `scripts/spike-jev.ts` is a throwaway Bun script that sends 3 Noul questions and prints the raw response. Without the key it prints a message and exits 0. Run it with a key to close the unverified items.

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
- **Logging hazard:** `logLevel: "debug"` logs request headers and bodies. Known credential headers are redacted, **bodies are not** (they contain source code). Scope must not enable `debug`/`info` logging by default, and should set `logLevel` explicitly rather than inherit `TYPESAFE_LOG_LEVEL`.

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
- **Unverified at runtime:** that the `noul` value is always finite and within [0, 1], and that every question id is present in `answers`. The types promise both, but Scope must validate (finite, in range, one per candidate) and treat violations as a Jev failure.

## Request limits

Documented (Models page, `jev-1.13.0`):

| Limit                                    | Value                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Context per request                      | 64k tokens covering `state` plus **all** questions combined                                                          |
| `state` plus the single longest question | 32k tokens                                                                                                           |
| Rate limits                              | 100K tokens per second and 80 requests per second; over either limit returns `429`. Stated to change without notice. |
| Input type                               | Text only (string, JSON object, array of text values)                                                                |
| Choice options / Score levels            | 255 options max per Choice; Score API accepts up to 10 levels (not relevant to Noul)                                 |

- **Maximum questions per request: not documented**, and the SDK enforces no client-side maximum (only non-empty). Treat as unknown. The token budget above is the only documented bound, so the adapter must batch candidates to stay under it.
- **Maximum payload size in bytes: not documented.** The limit is expressed in tokens. The adapter needs its own token estimate and conservative batch sizing; the true server behavior on an oversize request (status code, error body) is unverified. A 422 `UnprocessableEntityError` is the documented class for validation failures.
- Because the `state` is ingested once and all questions are evaluated against it, a per-candidate state is not required: one shared state (task plus candidates) with one Noul per candidate fits the batching model. The re-ranking cookbook instead sends one request per query-candidate pair; both are valid shapes, with quality differences **unverified** for Scope.
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
- The timeout covers the full response including body delivery. A larger batch may need a timeout above 10 s; the needed value is **unverified**.
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

Mapping of HTTP status to class is from the installed type doc comments; the runtime mapping itself is unverified.

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
3. Size batches by estimated tokens against the 64k combined and 32k state-plus-longest-question limits; there is no documented question-count or byte limit.
4. Own the overall deadline with `AbortSignal`; the SDK only has a per-attempt timeout.
5. Do not log request bodies; never print or persist the API key.
6. Record `usage` and latency per request for the M1 prototype evidence.

## Unverified items (need a live key)

- Real response shape for a batch of Noul questions (field presence, ordering, extra fields).
- Whether `noul` can fall outside [0, 1] or be non-finite.
- Behavior and error class when a request exceeds the token budget or contains very many questions.
- Latency and the right `timeout` for batches of roughly 20 to 50 candidates.
- Quality difference between a shared-state batch and one request per candidate.
- Effective rate limits (documented as changing without notice).
