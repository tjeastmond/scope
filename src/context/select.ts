import { MAX_SUPPORT_TOKENS, MIN_RELEVANCE } from "../config.ts";
import { byLocation, renderText } from "../output/text.ts";
import type { CodeChunk, ScopeMode, ScopeResult, SelectedChunk, TokenEstimator, UnmetCoherence } from "../types.ts";
import { requiredSupports } from "./coherence.ts";
import { mergeRegions, toScopeRegion } from "./regions.ts";

/** Nothing scored high enough, or nothing fit the budget, so there is no useful output to print. */
export class EmptySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptySelectionError";
  }
}

export interface SelectionOptions {
  task: string;
  mode: ScopeMode;
  budget: number;
  estimator: TokenEstimator;
  /** Every chunk of the repository by id, so supporting declarations outside the shortlist can be found. */
  chunks: ReadonlyMap<string, CodeChunk>;
  minScore?: number;
}

/** Highest score per estimated token first; ties break by path, range, then ID so output is deterministic. */
function compareByDensity(estimator: TokenEstimator) {
  const density = (item: SelectedChunk) => item.score / Math.max(estimator.count(item.chunk.content), 1);
  return (a: SelectedChunk, b: SelectedChunk) => density(b) - density(a) || byLocation(a, b);
}

/** A declaration included only because selected chunks need it; it was not judged, so it has no relevance. */
function supportEntry(chunk: CodeChunk, requirers: ReadonlyMap<string, CodeChunk>): SelectedChunk {
  const supported = [...requirers.values()].sort((a, b) => a.id.localeCompare(b.id));
  const names = supported.map((required) => required.name ?? required.file).join(", ");
  return {
    chunk,
    signals: {},
    score: 0,
    reason: `Supporting declaration for ${names}`,
    supportFor: supported.map((required) => required.id),
  };
}

const unmetKey = (chunkId: string, requiredId: string) => `${chunkId}\u0000${requiredId}`;

/**
 * Includes candidates (best score-per-token first) while the full rendered artifact, not just chunk bodies, still
 * fits the budget. The artifact merges touching or overlapping chunks into regions, so cost is measured on the union:
 * a chunk contained in an already chosen one adds only its label and is still recorded with its provenance. Candidates below the minimum score are dropped. A chosen chunk also pulls in the cheap supporting
 * declarations it needs (see `requiredSupports`), charged against the budget; supports that are too large or do not
 * fit are reported in `unmetCoherence`.
 */
export function selectWithinBudget(candidates: readonly SelectedChunk[], options: SelectionOptions): ScopeResult {
  const { task, mode, budget, estimator, chunks, minScore = MIN_RELEVANCE } = options;
  const eligible = candidates.filter((item) => item.score >= minScore).sort(compareByDensity(estimator));
  if (eligible.length === 0) {
    throw new EmptySelectionError(`No candidate scored at least ${minScore}; nothing relevant to select.`);
  }

  const chosen = new Map<string, SelectedChunk>();
  /** Support-only entries: chunk id to the chunks that required it. */
  const pulledIn = new Map<string, Map<string, CodeChunk>>();
  const unmet = new Map<string, UnmetCoherence>();
  const fits = (set: Iterable<SelectedChunk>) => estimator.count(renderText(task, [...set])) <= budget;
  let skipped = 0;

  for (const item of eligible) {
    const id = item.chunk.id;
    // A chunk already included as a support is upgraded: it keeps its own relevance (if its longer label still fits)
    // and, like any other candidate, brings in the supports it needs.
    const upgrading = pulledIn.has(id);
    if (chosen.has(id) && !upgrading) continue;

    const supports = requiredSupports(item.chunk, chunks);
    const needed = supports.filter((support) => !chosen.has(support.id));
    const affordable = needed.filter((support) => estimator.count(support.content) <= MAX_SUPPORT_TOKENS);
    const alone = new Map(chosen).set(id, item);
    const withSupports = new Map(alone);
    const additions = affordable.map((support) => supportEntry(support, new Map([[id, item.chunk]])));
    for (const entry of additions) withSupports.set(entry.chunk.id, entry);

    if (fits(withSupports.values())) {
      for (const [key, entry] of withSupports) chosen.set(key, entry);
      for (const entry of additions) pulledIn.set(entry.chunk.id, new Map([[id, item.chunk]]));
    } else if (fits(alone.values())) {
      chosen.set(id, item);
      for (const support of affordable)
        unmet.set(unmetKey(id, support.id), { chunkId: id, requiredId: support.id, reason: "over-budget" });
    } else {
      if (!upgrading) skipped++;
      continue;
    }
    pulledIn.delete(id);
    for (const support of needed) {
      if (!affordable.includes(support)) {
        unmet.set(unmetKey(id, support.id), { chunkId: id, requiredId: support.id, reason: "too-large" });
      }
    }
    // A support that is already in the output only because of an earlier chunk now also serves this one.
    for (const support of supports) pulledIn.get(support.id)?.set(id, item.chunk);
  }
  if (chosen.size === 0) {
    throw new EmptySelectionError(`No relevant chunk fits the budget of ${budget} estimated tokens; raise --budget.`);
  }

  // A requirement recorded earlier is met if its declaration was selected afterwards by another path.
  const unmetCoherence = [...unmet.values()]
    .filter((entry) => !chosen.has(entry.requiredId))
    .sort((a, b) => a.chunkId.localeCompare(b.chunkId) || a.requiredId.localeCompare(b.requiredId));
  const selected = [...chosen.values()].map((entry) => {
    const requirers = pulledIn.get(entry.chunk.id);
    return requirers ? supportEntry(entry.chunk, requirers) : entry;
  });

  const text = renderText(task, selected);
  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} relevant chunk(s) were left out to stay within the budget.`);
  if (unmetCoherence.length > 0) {
    warnings.push(`${unmetCoherence.length} coherence requirement(s) could not be included; see unmetCoherence.`);
  }
  return {
    schemaVersion: 1,
    mode,
    task,
    budget,
    estimator: estimator.id,
    estimatedTokens: estimator.count(text),
    characters: text.length,
    lines: text.split("\n").length,
    chunks: selected.sort(byLocation),
    regions: mergeRegions(selected).map(toScopeRegion),
    warnings,
    unmetCoherence,
  };
}
