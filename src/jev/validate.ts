import type { CodeChunk, RelevanceJudgment } from "../types.ts";
import { JevResponseError } from "./errors.ts";

/**
 * Validates untrusted Jev answers against the submitted candidate IDs: exactly one finite relevance in [0, 1] per
 * candidate, no extras. Returns judgments in candidate order.
 */
export function validateRelevance(
  ids: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): RelevanceJudgment[] {
  const expected = new Set(ids);
  if (expected.size !== ids.length) throw new JevResponseError("Duplicate candidate IDs were submitted to Jev.");
  const extra = Object.keys(answers).filter((key) => !expected.has(key));
  if (extra.length > 0) throw new JevResponseError(`Jev returned answers for unknown candidates: ${extra.join(", ")}.`);

  return ids.map((id) => {
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (answer === undefined) throw new JevResponseError(`Jev returned no answer for candidate ${id}.`);
    const value = (answer as { noul?: unknown } | null)?.noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new JevResponseError(`Jev returned an invalid relevance for candidate ${id}: ${String(value)}.`);
    }
    return { chunkId: id, relevance: value, raw: answer };
  });
}

/**
 * Checks any provider's judgments against the candidates they must cover: exactly one finite relevance in [0, 1]
 * per candidate, none unknown or repeated. Returns relevance by chunk ID.
 */
export function validateJudgments(
  candidates: readonly CodeChunk[],
  judgments: readonly RelevanceJudgment[],
): Map<string, number> {
  const known = new Set(candidates.map((chunk) => chunk.id));
  const relevance = new Map<string, number>();
  for (const { chunkId, relevance: value } of judgments) {
    if (!known.has(chunkId)) throw new JevResponseError(`Judgment for unknown candidate ${chunkId}.`);
    if (relevance.has(chunkId)) throw new JevResponseError(`Duplicate judgment for candidate ${chunkId}.`);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new JevResponseError(`Invalid relevance for candidate ${chunkId}: ${value}.`);
    }
    relevance.set(chunkId, value);
  }
  const missing = candidates.filter((chunk) => !relevance.has(chunk.id));
  if (missing.length > 0) throw new JevResponseError(`Missing judgments for ${missing.length} candidate(s).`);
  return relevance;
}
