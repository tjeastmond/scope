import { MAX_SUPPORT_TOKENS, MIN_RELEVANCE } from "../config.ts";
import { renderFormat, type OutputFormat } from "../output/index.ts";
import { byLocation } from "../output/text.ts";
import type {
  CodeChunk,
  ScopeMode,
  ScopeResult,
  SelectedChunk,
  SkippedChunk,
  TokenEstimator,
  UnmetCoherence,
} from "../types.ts";
import { requiredSupports } from "./coherence.ts";
import { mergeRegions, toScopeRegion } from "./regions.ts";

/** Relevant chunks exist but not even the smallest valid artifact fits the budget; the message names the minimum. */
export class BudgetTooSmallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetTooSmallError";
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
  /** Format of the emitted artifact; the budget is enforced on the whole artifact in this format (default text). */
  format?: OutputFormat;
  /** Warnings that precede the selection's own (scan, retrieval). They are part of the artifact, so they are measured. */
  leadingWarnings?: readonly string[];
  /** Embedded in the artifact (JSON), so it is measured. */
  retrievalConfigVersion?: string;
  /** `--explain`: the artifact carries selection evidence, so it is part of what is measured. */
  explain?: boolean;
}

/** Rounds of metric re-measurement before giving up and reporting the largest values seen. */
const MAX_SETTLE_ROUNDS = 8;

interface Metrics {
  estimatedTokens: number;
  characters: number;
  lines: number;
}

const overBudgetWarning = (count: number | string) =>
  `${count} relevant chunk(s) were left out to stay within the budget.`;
const unmetWarning = (count: number | string) =>
  `${count} coherence requirement(s) could not be included; see unmetCoherence.`;
const noRelevantWarning = (minScore: number, candidates: number) =>
  candidates === 0
    ? "No relevant chunks found; the result is empty."
    : `No relevant chunks found: no candidate scored at least ${minScore}; the result is empty.`;
const digits = (value: number) => String(Math.max(Math.trunc(value), 1)).length;

/** Highest score per estimated token first; ties break by path, range, then ID so output is deterministic. */
function compareByDensity(estimator: TokenEstimator) {
  const density = (item: SelectedChunk) => item.score / Math.max(estimator.count(item.chunk.content), 1);
  return (a: SelectedChunk, b: SelectedChunk) => density(b) - density(a) || byLocation(a, b);
}

/** Skipped chunks in the order the artifact lists them: by file, start line, then id. */
const bySkipLocation = (a: SkippedChunk, b: SkippedChunk) =>
  a.file.localeCompare(b.file) || a.startLine - b.startLine || a.chunkId.localeCompare(b.chunkId);

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

/** A candidate that was dropped, with its relevance and cost so the omission is inspectable. */
function skippedEntry(item: SelectedChunk, reason: SkippedChunk["reason"], minimumBudget?: number): SkippedChunk {
  const { chunk, relevance, score } = item;
  return {
    chunkId: chunk.id,
    file: chunk.file,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    ...(chunk.name === undefined ? {} : { name: chunk.name }),
    ...(relevance === undefined ? {} : { relevance }),
    score,
    estimatedTokens: chunk.estimatedTokens,
    reason,
    ...(minimumBudget === undefined ? {} : { minimumBudget }),
  };
}

const unmetKey = (chunkId: string, requiredId: string) => `${chunkId}\u0000${requiredId}`;

/**
 * Includes candidates (best score-per-token first) while the full rendered artifact, not just chunk bodies, still
 * fits the budget. The artifact merges touching or overlapping chunks into regions, so cost is measured on the union:
 * a chunk contained in an already chosen one adds only its label and is still recorded with its provenance.
 * A relevant chunk that fits neither with its supports nor alone is skipped whole, never truncated (a cut could land
 * mid-statement), and the loop moves on to smaller candidates. Every dropped candidate is recorded in `skipped` with
 * its cost (see docs/budget-policy.md). A chosen chunk also pulls in the cheap supporting declarations it needs (see
 * `requiredSupports`), charged against the budget; supports that are too large or do not fit are reported in
 * `unmetCoherence`.
 */
export function selectWithinBudget(candidates: readonly SelectedChunk[], options: SelectionOptions): ScopeResult {
  const { task, mode, budget, estimator, chunks, minScore = MIN_RELEVANCE } = options;
  const eligible = candidates.filter((item) => item.score >= minScore).sort(compareByDensity(estimator));
  const skipped = new Map<string, SkippedChunk>();
  for (const item of candidates) {
    if (item.score < minScore) skipped.set(item.chunk.id, skippedEntry(item, "below-threshold"));
  }
  const format = options.format ?? "text";
  const leadingWarnings = options.leadingWarnings ?? [];
  const measure = (text: string): Metrics => ({
    estimatedTokens: estimator.count(text),
    characters: text.length,
    lines: text.split("\n").length,
  });
  const sameMetrics = (a: Metrics, b: Metrics) =>
    a.estimatedTokens === b.estimatedTokens && a.characters === b.characters && a.lines === b.lines;
  const assemble = (
    selected: readonly SelectedChunk[],
    skippedChunks: SkippedChunk[],
    unmetCoherence: UnmetCoherence[],
    warnings: string[],
    metrics: Metrics,
  ): ScopeResult => {
    const sorted = [...selected].sort(byLocation);
    return {
      schemaVersion: 1,
      mode,
      task,
      budget,
      estimator: estimator.id,
      ...metrics,
      chunks: sorted,
      regions: mergeRegions(sorted).map(toScopeRegion),
      warnings,
      unmetCoherence,
      skipped: skippedChunks,
      ...(options.retrievalConfigVersion === undefined
        ? {}
        : { retrievalConfigVersion: options.retrievalConfigVersion }),
      ...(options.explain ? { explain: true as const } : {}),
    };
  };

  /**
   * The artifact embeds its own size, so the numbers are found by fixed-point iteration: render with the previous
   * round's numbers, measure, repeat until the embedded numbers equal the measured ones. Bounded; if it does not settle
   * the per-field maximum seen is embedded so the artifact never under-reports its size.
   */
  const settle = (build: (metrics: Metrics) => ScopeResult): { result: ScopeResult; text: string; exact: boolean } => {
    const seen: Metrics[] = [];
    let current: Metrics = { estimatedTokens: 0, characters: 0, lines: 1 };
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      const result = build(current);
      const text = renderFormat(format, result);
      const next = measure(text);
      if (sameMetrics(next, current)) return { result, text, exact: true };
      seen.push(next);
      current = next;
    }
    const largest: Metrics = {
      estimatedTokens: Math.max(...seen.map((m) => m.estimatedTokens)),
      characters: Math.max(...seen.map((m) => m.characters)),
      lines: Math.max(...seen.map((m) => m.lines)),
    };
    const result = build(largest);
    const text = renderFormat(format, result);
    const final = measure(text);
    // Only a bound if it really covers the artifact it was embedded in; otherwise the caller treats it as not fitting.
    const exact =
      final.estimatedTokens <= largest.estimatedTokens &&
      final.characters <= largest.characters &&
      final.lines <= largest.lines;
    return { result, text, exact };
  };

  // Phase 1 reservation: the numbers and warnings that are only known after selection are charged at their worst
  // plausible width (digits cost tokens), so that late additions rarely overflow. Phase 2 verifies and prunes.
  const widest = (value: number) => "9".repeat(digits(value));
  const worstCount = widest(candidates.length * 4);
  const reservedMetrics: Metrics = {
    estimatedTokens: budget,
    characters: Number(widest(budget * 16)),
    lines: Number(widest(budget * 16)),
  };
  // The skip list recorded so far (below-threshold and earlier over-budget entries, which the text and Markdown
  // "Left out" section lists) and the unmet requirements recorded so far (their section) are part of the artifact.
  const provisional = (set: Iterable<SelectedChunk>) =>
    assemble(
      [...set],
      [...skipped.values()],
      [...unmet.values()],
      [...leadingWarnings, overBudgetWarning(worstCount), unmetWarning(worstCount)],
      reservedMetrics,
    );
  const fits = (set: Iterable<SelectedChunk>) => estimator.count(renderFormat(format, provisional(set))) <= budget;
  /** Cost of an artifact holding only this chunk (no skip list or selection warnings, which depend on the rest). */
  const soloCost = (item: SelectedChunk) =>
    estimator.count(settle((metrics) => assemble([item], [], [], [...leadingWarnings], metrics)).text);

  if (eligible.length === 0) {
    // Nothing relevant is a valid answer, not a failure: an empty artifact that says so. Only a budget too small to
    // hold even that fails.
    const warnings = [...leadingWarnings, noRelevantWarning(minScore, candidates.length)];
    const { result, text, exact } = settle((metrics) =>
      assemble([], [...skipped.values()].sort(bySkipLocation), [], warnings, metrics),
    );
    const needed = estimator.count(text);
    if (exact && needed <= budget) return result;
    throw new BudgetTooSmallError(
      `The budget of ${budget} estimated tokens cannot hold even an empty result; --budget must be at least ${needed}.`,
    );
  }

  const chosen = new Map<string, SelectedChunk>();
  /** Support-only entries: chunk id to the chunks that required it. */
  const pulledIn = new Map<string, Map<string, CodeChunk>>();
  const unmet = new Map<string, UnmetCoherence>();

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
      // An upgrade candidate is already included as a support, so it is not a skipped chunk.
      if (!upgrading) skipped.set(id, skippedEntry(item, "over-budget", soloCost(item)));
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
  const emptyError = () =>
    new BudgetTooSmallError(
      `No relevant chunk fits the budget of ${budget} estimated tokens; ` +
        `--budget must be at least ${Math.min(...eligible.map(soloCost))} to include the smallest relevant chunk.`,
    );
  if (chosen.size === 0) throw emptyError();

  // Phase 2: build the true artifact (real skip list, requirements and warnings), measure it in the requested format,
  // and while it does not fit drop the lowest-value chunk (with supports only it required). At most one round per
  // chosen entry, so the loop is bounded.
  const pruned = new Map<string, SkippedChunk>();
  const density = (item: SelectedChunk) => item.score / Math.max(estimator.count(item.chunk.content), 1);
  /** Lowest value first: relevance (or score), then score per token, then the later location. */
  const pruneOrder = (a: SelectedChunk, b: SelectedChunk) =>
    (a.relevance ?? a.score) - (b.relevance ?? b.score) || density(a) - density(b) || byLocation(b, a);

  for (let rounds = chosen.size; rounds >= 0; rounds--) {
    // A requirement recorded earlier is met if its declaration was selected afterwards by another path.
    const unmetCoherence = [...unmet.values()]
      .filter((entry) => chosen.has(entry.chunkId) && !chosen.has(entry.requiredId))
      .sort((a, b) => a.chunkId.localeCompare(b.chunkId) || a.requiredId.localeCompare(b.requiredId));
    const selected = [...chosen.values()].map((entry) => {
      const requirers = pulledIn.get(entry.chunk.id);
      return requirers ? supportEntry(entry.chunk, requirers) : entry;
    });
    // A chunk skipped on its own turn can still end up included as another chunk's support; it is not skipped then.
    const skippedChunks = [...skipped.values(), ...pruned.values()]
      .filter((entry) => !chosen.has(entry.chunkId))
      .sort(bySkipLocation);
    const overBudget = skippedChunks.filter((entry) => entry.reason === "over-budget").length;
    const warnings = [...leadingWarnings];
    if (overBudget > 0) warnings.push(overBudgetWarning(overBudget));
    if (unmetCoherence.length > 0) warnings.push(unmetWarning(unmetCoherence.length));

    const { result, text, exact } = settle((metrics) =>
      assemble(selected, skippedChunks, unmetCoherence, warnings, metrics),
    );
    if (chosen.size === 0) break;
    if (exact && estimator.count(text) <= budget) return result;

    const victim = [...chosen.values()].filter((entry) => !pulledIn.has(entry.chunk.id)).sort(pruneOrder)[0];
    if (!victim || rounds === 0) break;
    const id = victim.chunk.id;
    chosen.delete(id);
    pruned.set(id, skippedEntry(victim, "over-budget", soloCost(victim)));
    for (const [supportId, requirers] of pulledIn) {
      requirers.delete(id);
      if (requirers.size === 0) {
        pulledIn.delete(supportId);
        chosen.delete(supportId);
      }
    }
    // A chunk that relied on the pruned one (chosen earlier on its own merits) now lacks it.
    for (const entry of chosen.values()) {
      if (pulledIn.has(entry.chunk.id)) continue;
      if (requiredSupports(entry.chunk, chunks).some((support) => support.id === id)) {
        unmet.set(unmetKey(entry.chunk.id, id), { chunkId: entry.chunk.id, requiredId: id, reason: "over-budget" });
      }
    }
  }
  throw emptyError();
}
