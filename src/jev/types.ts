import type { CodeChunk } from "../types.ts";

/** Relevance of one candidate, as the probability (0-1) that it is needed for the task. */
export interface Judgment {
  id: string;
  relevance: number;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult {
  /** One judgment per candidate, in candidate order. */
  judgments: Judgment[];
  usage: JevUsage;
  latencyMs: number;
  model?: string;
}

/** Decides how relevant each candidate is to a task. The default implementation is Jev; tests inject a fake. */
export interface DecisionProvider {
  judge(task: string, candidates: readonly CodeChunk[], signal?: AbortSignal): Promise<DecisionResult>;
}

/** Jev (or a provider) answered, but the answer cannot be trusted. Never recovered silently. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}
