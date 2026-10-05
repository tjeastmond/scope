import { JevResponseError, type Judgment } from "./types.ts";

/**
 * Validates untrusted Jev answers against the submitted candidate IDs: exactly one finite relevance in [0, 1] per
 * candidate, no extras. Returns judgments in candidate order.
 */
export function validateRelevance(ids: readonly string[], answers: Readonly<Record<string, unknown>>): Judgment[] {
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
    return { id, relevance: value };
  });
}
