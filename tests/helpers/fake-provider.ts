import { JevUnavailableError } from "../../src/jev/errors.ts";
import type { CodeChunk, DecisionProvider } from "../../src/types.ts";

export type Failure = "timeout" | "malformed" | "partial";

export interface FakeProviderOptions {
  /** Relevance by symbol name; candidates not listed get `fallback`. */
  relevance?: Record<string, number>;
  fallback?: number;
  failure?: Failure;
}

/** Deterministic stand-in for Jev: a lookup table by symbol, with optional injected failures. */
export function fakeProvider({ relevance = {}, fallback = 0.1, failure }: FakeProviderOptions = {}): DecisionProvider {
  const judge = (chunk: CodeChunk) => relevance[chunk.name ?? ""] ?? fallback;
  return {
    async decide({ candidates }) {
      if (failure === "timeout") throw new JevUnavailableError("Jev did not complete: the request timed out.");
      const judgments = candidates.map((chunk) => ({
        chunkId: chunk.id,
        relevance: failure === "malformed" ? Number.NaN : judge(chunk),
      }));
      return {
        judgments: failure === "partial" ? judgments.slice(1) : judgments,
        usage: { inputTokens: 5, outputTokens: 1 },
        latencyMs: 3,
      };
    },
  };
}
