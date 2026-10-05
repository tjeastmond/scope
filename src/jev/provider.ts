import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import { JEV_ATTEMPT_TIMEOUT_MS, JEV_BATCH_TOKEN_BUDGET, JEV_DEADLINE_MS } from "../config.ts";
import { charsPerTokenEstimator } from "../context/tokens.ts";
import type { CodeChunk, DecisionProvider, DecisionRequest, DecisionResult, RelevanceJudgment } from "../types.ts";
import { JevRequestError, JevUnavailableError } from "./errors.ts";
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
  batchTokenBudget?: number;
  deadlineMs?: number;
}

const CRITERIA = {
  true: "The code must be read or changed to complete the task, or defines something that code doing so depends on.",
  false: "The code is unrelated to the task, or only shares words with it.",
};

/** Builds the real client. Reads TYPESAFE_API_KEY from the environment only and never enables SDK logging. */
export function createJevClient(): JevClient {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new JevUnavailableError(
      "TYPESAFE_API_KEY is not set. Set it to run Scope with Jev, or pass --no-jev for the offline baseline.",
    );
  }
  // logLevel "off": debug logging would print request bodies (source code) and part of the key.
  return new TypeSafeClient({ logLevel: "off", timeout: JEV_ATTEMPT_TIMEOUT_MS }) as unknown as JevClient;
}

function describe(chunk: CodeChunk) {
  return {
    path: chunk.file,
    symbol: chunk.name ?? null,
    kind: chunk.kind,
    lines: `${chunk.startLine}-${chunk.endLine}`,
    code: chunk.content,
  };
}

/** Greedily groups candidates so each request's estimated tokens stay within the budget. */
function batch(candidates: readonly CodeChunk[], budget: number): CodeChunk[][] {
  const batches: CodeChunk[][] = [];
  let current: CodeChunk[] = [];
  let used = 0;
  for (const chunk of candidates) {
    const cost = charsPerTokenEstimator.count(chunk.content) + 100;
    if (cost > budget) {
      throw new JevRequestError(`${chunk.file}:${chunk.startLine} is too large to send to Jev (~${cost} tokens).`);
    }
    if (current.length > 0 && used + cost > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(chunk);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function failure(error: unknown, signal: AbortSignal): JevUnavailableError {
  if (signal.aborted) return new JevUnavailableError("Jev did not complete: the request was cancelled or timed out.");
  const status = (error as { status?: unknown } | null)?.status;
  const name = error instanceof Error ? error.name : "Error";
  // Deliberately omit the SDK message and body: they can echo request content.
  return new JevUnavailableError(
    `Jev request failed (${name}${typeof status === "number" ? `, HTTP ${status}` : ""}).`,
    {
      cause: error,
    },
  );
}

/** Asks Jev one yes/no relevance question per candidate (a Noul), batched within request limits. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly client: JevClient;
  private readonly batchTokenBudget: number;
  private readonly deadlineMs: number;

  constructor(options: JevProviderOptions = {}) {
    this.client = options.client ?? createJevClient();
    this.batchTokenBudget = options.batchTokenBudget ?? JEV_BATCH_TOKEN_BUDGET;
    this.deadlineMs = options.deadlineMs ?? JEV_DEADLINE_MS;
  }

  async decide({ task, candidates, signal }: DecisionRequest): Promise<DecisionResult> {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = performance.now();
    const judgments: RelevanceJudgment[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    // Question IDs are not sent to the model, so each question names its candidate by state path.
    let ordinal = 0;
    for (const group of batch(candidates, this.batchTokenBudget)) {
      const refs = group.map(() => `c${ordinal++}`);
      const state = { task, candidates: Object.fromEntries(group.map((chunk, i) => [refs[i], describe(chunk)])) };
      const questions = Object.fromEntries(
        refs.map((ref) => [
          ref,
          noul(`Is the code in \`candidates.${ref}\` needed to complete the task described in \`task\`?`, CRITERIA),
        ]),
      );
      let response;
      try {
        response = await this.client.systemOne({ state, questions }, { signal: combined });
      } catch (error) {
        throw failure(error, combined);
      }
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      validateRelevance(refs, response.answers).forEach((judgment, i) => {
        judgments.push({ ...judgment, chunkId: group[i]!.id });
      });
    }

    return { judgments, usage: { inputTokens, outputTokens }, latencyMs: Math.round(performance.now() - started) };
  }
}
