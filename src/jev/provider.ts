import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  BadRequestError,
  TypeSafeClient,
  noul,
} from "@typesafe-ai/sdk";
import {
  JEV_ATTEMPT_TIMEOUT_MS,
  JEV_BATCH_MAX_CHARS,
  JEV_BATCH_MAX_QUESTIONS,
  JEV_CANDIDATE_MAX_CHARS,
  JEV_CONCURRENCY,
  JEV_DEADLINE_MS,
  JEV_MAX_RETRIES,
  JEV_MAX_RETRY_AFTER_MS,
} from "../config.ts";
import type {
  CodeChunk,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  JevRequestMetrics,
  RelevanceJudgment,
} from "../types.ts";
import {
  JevAuthError,
  JevCancelledError,
  JevError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevServiceError,
  JevTimeoutError,
} from "./errors.ts";
import { validateRelevance } from "./validate.ts";

/** The slice of the SDK client Scope uses, so tests can inject a fake. */
export interface JevClient {
  systemOne(
    request: { state: Record<string, unknown>; questions: Record<string, unknown>; model: string },
    options: { signal: AbortSignal },
  ): PromiseLike<{
    answers: Readonly<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export interface JevProviderOptions {
  client?: JevClient;
  batchMaxChars?: number;
  /** Questions (candidates) per request (default JEV_BATCH_MAX_QUESTIONS). */
  batchMaxQuestions?: number;
  /** Requests in flight at once (default JEV_CONCURRENCY). */
  concurrency?: number;
  /** Characters of one candidate's code sent for judging (default JEV_CANDIDATE_MAX_CHARS). */
  candidateMaxChars?: number;
  deadlineMs?: number;
}

export interface JevRequestLimits {
  batchMaxChars?: number;
  batchMaxQuestions?: number;
  candidateMaxChars?: number;
}

export type JevRequest = Parameters<JevClient["systemOne"]>[0];

/**
 * The question design (version JEV_QUESTION_VERSION): one judgment per question, one question per candidate. Question
 * ids are not sent to the model, so each question names its candidate by its state path and says how the candidate is
 * identified. Repository text (paths, symbol names) is never interpolated into instructions; it lives only in `state`,
 * which keeps untrusted repository text out of the instructions. Any change to this text or to CRITERIA requires
 * bumping JEV_QUESTION_VERSION.
 */
const question = (ref: string) =>
  `Is the code in \`candidates.${ref}\` (identified by its \`path\`, \`symbol\` and \`lines\`) needed to complete the task described in \`task\`?`;

const CRITERIA = {
  true: "The code must be read or changed to complete the task, or defines something that code doing so depends on.",
  false: "The code is unrelated to the task, or only shares words with it.",
};

export interface JevClientOptions {
  /** Timeout of one HTTP attempt in milliseconds (default JEV_ATTEMPT_TIMEOUT_MS). */
  attemptTimeoutMs?: number;
  /** Test seam: the SDK's HTTP transport (default: global fetch). */
  fetch?: typeof fetch;
}

/**
 * The model Jev answers with, resolved the way the SDK resolves its default (TYPESAFE_DEFAULT_MODEL, then
 * `jev-latest`). Scope sends it explicitly, so the SDK transmits the planned body unchanged and the payload audit names it.
 */
export const jevModel = (): string => process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";

/** Builds the real client. Reads TYPESAFE_API_KEY from the environment only and never enables SDK logging. */
export function createJevClient(options: JevClientOptions = {}): JevClient {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new JevAuthError("TYPESAFE_API_KEY is not set.");
  }
  // logLevel "off": debug logging would print request bodies (source code) and part of the key.
  return new TypeSafeClient({
    logLevel: "off",
    timeout: options.attemptTimeoutMs ?? JEV_ATTEMPT_TIMEOUT_MS,
    // Spelled out rather than inherited, so the worst case documented at JEV_DEADLINE_MS rests on values Scope sets.
    retry: {
      maxRetries: JEV_MAX_RETRIES,
      backoffInitialMs: 500,
      backoffMaxMs: 5_000,
      backoffJitter: 0.25,
      httpStatuses: new Set([408, 429, ...Array.from({ length: 100 }, (_unused, i) => 500 + i)]),
      respectRetryAfter: true,
      maxRetryAfterMs: JEV_MAX_RETRY_AFTER_MS,
      apiConnectionError: true,
      apiTimeoutError: true,
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }) as unknown as JevClient;
}

/** The code Jev sees: the whole chunk, or its first `cap` characters plus a marker saying how much was cut. */
function judgedCode(content: string, cap: number): string {
  if (content.length <= cap) return content;
  let end = cap;
  // Never cut between the halves of a surrogate pair.
  const last = content.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${content.slice(0, end)}\n[truncated for judging: showed ${end} of ${content.length} characters]`;
}

function describe(chunk: CodeChunk, cap: number) {
  return {
    path: chunk.file,
    symbol: chunk.name ?? null,
    kind: chunk.kind,
    lines: `${chunk.startLine}-${chunk.endLine}`,
    code: judgedCode(chunk.content, cap),
  };
}

interface Batch {
  chunks: CodeChunk[];
  refs: string[];
  request: JevRequest;
}

/** One request for a group of candidates (see `question` for the design); `first` keeps refs unique across batches. */
function buildBatch(task: string, chunks: CodeChunk[], first: number, cap: number, model: string): Batch {
  const refs = chunks.map((_chunk, i) => `c${first + i}`);
  const state = { task, candidates: Object.fromEntries(chunks.map((chunk, i) => [refs[i], describe(chunk, cap)])) };
  const questions = Object.fromEntries(refs.map((ref) => [ref, noul(question(ref), CRITERIA)]));
  return { chunks, refs, request: { state, questions, model } };
}

const requestChars = (batch: Batch) => JSON.stringify(batch.request).length;

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/**
 * Greedily fills requests, measuring each as it would be serialized (task, metadata and questions included). A request
 * closes when the next candidate would exceed the character limit or the question limit.
 */
function planBatches(
  task: string,
  candidates: readonly CodeChunk[],
  limit: number,
  maxQuestions: number,
  cap: number,
): Batch[] {
  requirePositiveInteger("batchMaxQuestions", maxQuestions);
  const model = jevModel();
  const batches: Batch[] = [];
  let current: CodeChunk[] = [];
  let first = 0;
  for (const chunk of candidates) {
    if (
      current.length > 0 &&
      (current.length >= maxQuestions || requestChars(buildBatch(task, [...current, chunk], first, cap, model)) > limit)
    ) {
      batches.push(buildBatch(task, current, first, cap, model));
      first += current.length;
      current = [];
    }
    current.push(chunk);
    const size = requestChars(buildBatch(task, current, first, cap, model));
    if (current.length === 1 && size > limit) {
      throw new JevRequestError(
        `${chunk.file}:${chunk.startLine} with the task is too large to send to Jev (${size} characters).`,
      );
    }
  }
  if (current.length > 0) batches.push(buildBatch(task, current, first, cap, model));
  return batches;
}

/**
 * The exact request bodies sent to Jev for these candidates, in order. `decide` sends these same objects, so an audit of
 * this output cannot drift from what leaves the machine.
 */
export function planJevRequests(
  task: string,
  candidates: readonly CodeChunk[],
  {
    batchMaxChars = JEV_BATCH_MAX_CHARS,
    batchMaxQuestions = JEV_BATCH_MAX_QUESTIONS,
    candidateMaxChars = JEV_CANDIDATE_MAX_CHARS,
  }: JevRequestLimits = {},
): JevRequest[] {
  return planBatches(task, candidates, batchMaxChars, batchMaxQuestions, candidateMaxChars).map(
    (batch) => batch.request,
  );
}

/** Request-shaping configuration of a Jev adapter: everything that changes the payload it would send. */
function decisionCacheKeyFor(task: string, candidates: readonly CodeChunk[], limits: JevRequestLimits): unknown {
  return { provider: "jev", payload: planJevRequests(task, candidates, limits) };
}

/**
 * The decision-cache key material of a default-constructed Jev adapter, computed without a client or credentials. The
 * class method uses the same helper, so the two cannot drift.
 */
export function defaultDecisionCacheKey(task: string, candidates: readonly CodeChunk[]): unknown {
  return decisionCacheKeyFor(task, candidates, {});
}

const isTooLarge = (error: BadRequestError) => {
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail;
  return (detail as { error_type?: unknown } | null | undefined)?.error_type === "max_tokens_exceeded";
};

/**
 * Maps an SDK failure to a typed Scope error. `caller` is the caller's signal and `deadline` Scope's own overall
 * timeout, so a Ctrl-C is told apart from a deadline. Deliberately omits the SDK message, body, headers and `cause`
 * (they can echo request content and credentials); only the error kind, HTTP status and request id are used.
 */
function failure(error: unknown, caller: AbortSignal | undefined, deadline: AbortSignal): JevError {
  if (caller?.aborted) return new JevCancelledError("Jev request cancelled.");
  if (deadline.aborted) return new JevTimeoutError("Jev did not respond before Scope's overall deadline; try again.");
  if (error instanceof APIUserAbortError) return new JevCancelledError("Jev request cancelled.");
  if (error instanceof APITimeoutError) return new JevTimeoutError("Jev request timed out; try again.");
  if (error instanceof APIError) {
    const { status } = error;
    if (status === 401) return new JevAuthError("Jev rejected the credentials (HTTP 401); check TYPESAFE_API_KEY.");
    if (status === 403) return new JevAuthError("Jev denied access (HTTP 403); check TYPESAFE_API_KEY.");
    if (status === 429) return new JevRateLimitError("Jev rate limit reached (HTTP 429); try again later.");
    if (error instanceof BadRequestError && isTooLarge(error))
      return new JevRequestError("The request exceeds Jev's token limit; narrow the task or the repository.");
    // No request id: it is server-supplied with no documented format, so it could carry a credential.
    return new JevServiceError(`Jev request failed (HTTP ${status}).`);
  }
  if (error instanceof APIConnectionError) return new JevServiceError("Could not reach Jev (connection error).");
  return new JevServiceError("Jev request failed unexpectedly.");
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Token counts from an untrusted response: non-negative integers, or a JevResponseError. */
function validateUsage(usage: unknown): { input: number; output: number } {
  const { input_tokens: input, output_tokens: output } = (usage ?? {}) as Record<string, unknown>;
  if (!isCount(input) || !isCount(output)) throw new JevResponseError("Jev returned invalid token usage.");
  return { input, output };
}

/**
 * Runs `run` over every item with at most `concurrency` in flight. Items start in order; once `stopped()` is true no
 * further item starts. `run` must not reject (callers record failures themselves), so no rejection can go unhandled.
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  stopped: () => boolean,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopped() && next < items.length) {
      const index = next++;
      await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Asks Jev one yes/no relevance question per candidate (a Noul), batched within request limits. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly client: JevClient;
  private readonly batchMaxChars: number;
  private readonly batchMaxQuestions: number;
  private readonly concurrency: number;
  private readonly candidateMaxChars: number;
  private readonly deadlineMs: number;

  constructor(options: JevProviderOptions = {}) {
    this.client = options.client ?? createJevClient();
    this.batchMaxChars = options.batchMaxChars ?? JEV_BATCH_MAX_CHARS;
    this.batchMaxQuestions = requirePositiveInteger(
      "batchMaxQuestions",
      options.batchMaxQuestions ?? JEV_BATCH_MAX_QUESTIONS,
    );
    this.concurrency = requirePositiveInteger("concurrency", options.concurrency ?? JEV_CONCURRENCY);
    this.candidateMaxChars = options.candidateMaxChars ?? JEV_CANDIDATE_MAX_CHARS;
    this.deadlineMs = options.deadlineMs ?? JEV_DEADLINE_MS;
  }

  /** Identifies the payload this adapter would send, with its own configured limits (no client or credentials). */
  decisionCacheKey(task: string, candidates: readonly CodeChunk[]): unknown {
    return decisionCacheKeyFor(task, candidates, {
      batchMaxChars: this.batchMaxChars,
      batchMaxQuestions: this.batchMaxQuestions,
      candidateMaxChars: this.candidateMaxChars,
    });
  }

  async decide({ task, candidates, signal }: DecisionRequest): Promise<DecisionResult> {
    const seen = new Set<string>();
    for (const { id } of candidates) {
      if (seen.has(id)) throw new JevRequestError(`Two candidates share the chunk ID ${id}; nothing was sent to Jev.`);
      seen.add(id);
    }
    const batches = planBatches(task, candidates, this.batchMaxChars, this.batchMaxQuestions, this.candidateMaxChars);

    const deadline = AbortSignal.timeout(this.deadlineMs);
    // Aborted when one request fails, so its in-flight siblings stop. `failure` looks only at the caller and deadline
    // signals, so the original error is mapped as itself, never as a cancellation caused by this abort.
    const internal = new AbortController();
    const combined = AbortSignal.any([...(signal ? [signal] : []), deadline, internal.signal]);
    const started = performance.now();
    const relevanceById = new Map<string, RelevanceJudgment>();
    // Indexed by plan position, so the order is the plan's, not completion order.
    const requestMetrics = new Array<JevRequestMetrics | undefined>(batches.length).fill(undefined);
    let inputTokens = 0;
    let outputTokens = 0;
    let firstFailure: JevError | undefined;
    const fail = (error: JevError) => {
      firstFailure ??= error;
      internal.abort();
    };

    // The deadline holds even if a request ignores its signal: the run stops waiting the moment any signal fires.
    let stopWaiting = () => {};
    const stopped = new Promise<void>((resolve) => {
      const onAbort = () => {
        if (signal?.aborted) fail(new JevCancelledError("Jev request cancelled."));
        else if (deadline.aborted)
          fail(new JevTimeoutError("Jev did not respond before Scope's overall deadline; try again."));
        resolve();
      };
      if (combined.aborted) onAbort();
      else combined.addEventListener("abort", onAbort, { once: true });
      stopWaiting = () => combined.removeEventListener("abort", onAbort);
    });

    const pool = runPool(
      batches,
      this.concurrency,
      () => firstFailure !== undefined,
      async ({ chunks, refs, request }, index) => {
        let response;
        const requestStarted = performance.now();
        try {
          response = await this.client.systemOne(request, { signal: combined });
        } catch (error) {
          // Siblings aborted by an earlier failure end up here too; their errors are ignored.
          if (firstFailure === undefined) fail(failure(error, signal, deadline));
          return;
        }
        const latencyMs = Math.round(performance.now() - requestStarted);
        if (firstFailure !== undefined) return;
        // Every check on the untrusted response sits inside this block, so any failure stops the siblings too.
        try {
          const judgments = validateRelevance(refs, response.answers);
          const tokens = validateUsage(response.usage);
          judgments.forEach((judgment, i) => {
            const chunkId = chunks[i]!.id;
            if (relevanceById.has(chunkId)) throw new JevResponseError(`Candidate ${chunkId} was judged twice.`);
            relevanceById.set(chunkId, { ...judgment, chunkId });
          });
          inputTokens += tokens.input;
          outputTokens += tokens.output;
          requestMetrics[index] = { latencyMs, inputTokens: tokens.input, outputTokens: tokens.output };
        } catch (error) {
          fail(error instanceof JevError ? error : new JevResponseError("Jev returned an unusable answer."));
          return;
        }
      },
    );
    await Promise.race([pool, stopped]);
    stopWaiting();
    if (firstFailure) throw firstFailure;

    const judgments = candidates.map((chunk) => {
      const judgment = relevanceById.get(chunk.id);
      if (!judgment) throw new JevResponseError(`No judgment was returned for candidate ${chunk.id}.`);
      return judgment;
    });
    return {
      judgments,
      usage: { inputTokens, outputTokens },
      latencyMs: Math.round(performance.now() - started),
      requests: requestMetrics.map((metrics) => metrics!),
    };
  }
}
