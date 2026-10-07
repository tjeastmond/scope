import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  BadRequestError,
  TypeSafeClient,
  noul,
} from "@typesafe-ai/sdk";
import { JEV_ATTEMPT_TIMEOUT_MS, JEV_BATCH_MAX_CHARS, JEV_CANDIDATE_MAX_CHARS, JEV_DEADLINE_MS } from "../config.ts";
import type { CodeChunk, DecisionProvider, DecisionRequest, DecisionResult, RelevanceJudgment } from "../types.ts";
import {
  JevAuthError,
  JevCancelledError,
  JevRateLimitError,
  JevRequestError,
  JevServiceError,
  JevTimeoutError,
  type JevError,
} from "./errors.ts";
import { validateRelevance } from "./validate.ts";

/** The slice of the SDK client Scope uses, so tests can inject a fake. */
export interface JevClient {
  systemOne(
    request: { state: Record<string, unknown>; questions: Record<string, unknown> },
    options: { signal: AbortSignal },
  ): PromiseLike<{
    answers: Readonly<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export interface JevProviderOptions {
  client?: JevClient;
  batchMaxChars?: number;
  /** Characters of one candidate's code sent for judging (default JEV_CANDIDATE_MAX_CHARS). */
  candidateMaxChars?: number;
  deadlineMs?: number;
}

export interface JevRequestLimits {
  batchMaxChars?: number;
  candidateMaxChars?: number;
}

export type JevRequest = Parameters<JevClient["systemOne"]>[0];

const question = (ref: string) =>
  `Is the code in \`candidates.${ref}\` needed to complete the task described in \`task\`?`;

const CRITERIA = {
  true: "The code must be read or changed to complete the task, or defines something that code doing so depends on.",
  false: "The code is unrelated to the task, or only shares words with it.",
};

export interface JevClientOptions {
  /** Timeout of one HTTP attempt in milliseconds (default JEV_ATTEMPT_TIMEOUT_MS). */
  attemptTimeoutMs?: number;
}

/** Builds the real client. Reads TYPESAFE_API_KEY from the environment only and never enables SDK logging. */
export function createJevClient(options: JevClientOptions = {}): JevClient {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new JevAuthError(
      "TYPESAFE_API_KEY is not set. Set it to run Scope with Jev, or pass --no-jev for the offline baseline.",
    );
  }
  // logLevel "off": debug logging would print request bodies (source code) and part of the key.
  return new TypeSafeClient({
    logLevel: "off",
    timeout: options.attemptTimeoutMs ?? JEV_ATTEMPT_TIMEOUT_MS,
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

/** One request for a group of candidates. Question IDs are not sent to the model, so each question names its
 * candidate by its state path; `first` keeps refs unique across batches. */
function buildBatch(task: string, chunks: CodeChunk[], first: number, cap: number): Batch {
  const refs = chunks.map((_chunk, i) => `c${first + i}`);
  const state = { task, candidates: Object.fromEntries(chunks.map((chunk, i) => [refs[i], describe(chunk, cap)])) };
  const questions = Object.fromEntries(refs.map((ref) => [ref, noul(question(ref), CRITERIA)]));
  return { chunks, refs, request: { state, questions } };
}

const requestChars = (batch: Batch) => JSON.stringify(batch.request).length;

/** Greedily fills requests, measuring each as it would be serialized (task, metadata and questions included). */
function planBatches(task: string, candidates: readonly CodeChunk[], limit: number, cap: number): Batch[] {
  const batches: Batch[] = [];
  let current: CodeChunk[] = [];
  let first = 0;
  for (const chunk of candidates) {
    if (current.length > 0 && requestChars(buildBatch(task, [...current, chunk], first, cap)) > limit) {
      batches.push(buildBatch(task, current, first, cap));
      first += current.length;
      current = [];
    }
    current.push(chunk);
    const size = requestChars(buildBatch(task, current, first, cap));
    if (current.length === 1 && size > limit) {
      throw new JevRequestError(
        `${chunk.file}:${chunk.startLine} with the task is too large to send to Jev (${size} characters).`,
      );
    }
  }
  if (current.length > 0) batches.push(buildBatch(task, current, first, cap));
  return batches;
}

/**
 * The exact request bodies sent to Jev for these candidates, in order. `decide` sends these same objects, so an audit of
 * this output cannot drift from what leaves the machine.
 */
export function planJevRequests(
  task: string,
  candidates: readonly CodeChunk[],
  { batchMaxChars = JEV_BATCH_MAX_CHARS, candidateMaxChars = JEV_CANDIDATE_MAX_CHARS }: JevRequestLimits = {},
): JevRequest[] {
  return planBatches(task, candidates, batchMaxChars, candidateMaxChars).map((batch) => batch.request);
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
    const id = error.requestId?.match(/^[\w-]{1,64}$/) ? `, request ${error.requestId}` : "";
    return new JevServiceError(`Jev request failed (HTTP ${status}${id}).`);
  }
  if (error instanceof APIConnectionError) return new JevServiceError("Could not reach Jev (connection error).");
  return new JevServiceError("Jev request failed unexpectedly.");
}

/** Asks Jev one yes/no relevance question per candidate (a Noul), batched within request limits. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly client: JevClient;
  private readonly batchMaxChars: number;
  private readonly candidateMaxChars: number;
  private readonly deadlineMs: number;

  constructor(options: JevProviderOptions = {}) {
    this.client = options.client ?? createJevClient();
    this.batchMaxChars = options.batchMaxChars ?? JEV_BATCH_MAX_CHARS;
    this.candidateMaxChars = options.candidateMaxChars ?? JEV_CANDIDATE_MAX_CHARS;
    this.deadlineMs = options.deadlineMs ?? JEV_DEADLINE_MS;
  }

  async decide({ task, candidates, signal }: DecisionRequest): Promise<DecisionResult> {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = performance.now();
    const judgments: RelevanceJudgment[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (const { chunks, refs, request } of planBatches(task, candidates, this.batchMaxChars, this.candidateMaxChars)) {
      let response;
      try {
        response = await this.client.systemOne(request, { signal: combined });
      } catch (error) {
        throw failure(error, signal, deadline);
      }
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      validateRelevance(refs, response.answers).forEach((judgment, i) => {
        judgments.push({ ...judgment, chunkId: chunks[i]!.id });
      });
    }

    return { judgments, usage: { inputTokens, outputTokens }, latencyMs: Math.round(performance.now() - started) };
  }
}
