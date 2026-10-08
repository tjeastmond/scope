import { createHash } from "node:crypto";
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from "../retrieval/config.ts";
import { generateCandidates } from "../retrieval/generate.ts";
import type { Signal } from "../retrieval/score.ts";
import type { CodeChunk } from "../types.ts";
import { collectEvidence, isConfirmedIrrelevant, isConfirmedUseful } from "./evidence.ts";
import type { FeedbackRecord } from "./feedback.ts";
import { contentFingerprint, type HistoryRecord } from "./history.ts";
import { canonical, macEquals, recordMac } from "./integrity.ts";
import { commitRepositoryCache, type RepositoryCache } from "./location.ts";
import type { DocumentType } from "./store.ts";

/**
 * Adaptive retrieval weights (#78). The baseline is `DEFAULT_RETRIEVAL_CONFIG.weights`: it lives in code, is never
 * stored and never changes here. At most one signed document, `weights-active`, holds a promoted set of multipliers,
 * each within `1 +- ADAPTIVE_BOUND`, applied to the baseline weights of a Jev run with the cache on. A set is promoted
 * only when it beats the baseline on held-out tasks (see {@link judgePromotion}); `scope cache reset-weights` removes it
 * and restores the baseline exactly.
 *
 * The document holds numbers only: the multipliers and the held-out recall counts that justified them. Never task
 * text, source code, labels or answers.
 */

/** Largest relative change to any baseline weight: multipliers stay in [1 - B, 1 + B]. */
export const ADAPTIVE_BOUND = 0.2;
export const WEIGHTS_DOCUMENT = "weights-active";
export const WEIGHTS_RECORD_VERSION = 1;
const MAC_DOMAIN = "weights";
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The signals, in the order of the baseline weights. */
export const SIGNAL_NAMES = ["symbol", "lexical", "path", "dependency", "test", "proximity"] as const;
export type Multipliers = Record<Signal, number>;

/** Held-out candidate recall as a count: labels found in the shortlist out of labels required. */
export interface RecallCount {
  found: number;
  total: number;
}

export interface Evaluation {
  /** Held-out tasks evaluated. */
  tasks: number;
  baseline: RecallCount;
  proposal: RecallCount;
}

export interface WeightsRecord {
  recordVersion: 1;
  /** `adaptive-<12 hex>` over the baseline version and the multipliers. */
  version: string;
  /** The retrieval config version these multipliers were derived for; another baseline makes the set stale. */
  baselineVersion: string;
  multipliers: Multipliers;
  /** Milliseconds since the epoch when the set was promoted. */
  promotedAt: number;
  evaluation: Evaluation;
}

interface WeightsDocument {
  record: WeightsRecord;
  /** HMAC of the record and the repository root under the user's integrity key. */
  mac: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const LOW = 1 - ADAPTIVE_BOUND;
const HIGH = 1 + ADAPTIVE_BOUND;
const inBounds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= LOW && value <= HIGH;

/** Whether `value` is one multiplier per signal, each finite and within the bound. */
export const isMultipliers = (value: unknown): value is Multipliers =>
  isObject(value) && hasExactKeys(value, SIGNAL_NAMES) && SIGNAL_NAMES.every((name) => inBounds(value[name]));

const isRecallCount = (value: unknown): value is RecallCount =>
  isObject(value) &&
  hasExactKeys(value, ["found", "total"]) &&
  isCount(value.found) &&
  isCount(value.total) &&
  value.found <= value.total;

const isEvaluation = (value: unknown): value is Evaluation =>
  isObject(value) &&
  hasExactKeys(value, ["tasks", "baseline", "proposal"]) &&
  isCount(value.tasks) &&
  isRecallCount(value.baseline) &&
  isRecallCount(value.proposal);

/** The version name of a multiplier set for a baseline: `adaptive-` and the first 12 hex of a SHA-256. */
export function adaptiveVersion(baselineVersion: string, multipliers: Multipliers): string {
  const digest = createHash("sha256")
    .update(canonical([baselineVersion, multipliers]))
    .digest("hex");
  return `adaptive-${digest.slice(0, 12)}`;
}

/** The retrieval config version of a run that uses `record` on top of the baseline `baseVersion`. */
export const adaptiveConfigVersion = (baseVersion: string, record: WeightsRecord): string =>
  `${baseVersion}+${record.version}`;

/** Shape check of a record, including the bound and that the version names exactly these multipliers. */
export function isWeightsRecord(value: unknown): value is WeightsRecord {
  return (
    isObject(value) &&
    hasExactKeys(value, ["recordVersion", "version", "baselineVersion", "multipliers", "promotedAt", "evaluation"]) &&
    value.recordVersion === WEIGHTS_RECORD_VERSION &&
    typeof value.baselineVersion === "string" &&
    value.baselineVersion.length > 0 &&
    value.baselineVersion.length <= 200 &&
    isMultipliers(value.multipliers) &&
    value.version === adaptiveVersion(value.baselineVersion, value.multipliers) &&
    isCount(value.promotedAt) &&
    isEvaluation(value.evaluation)
  );
}

const isWeightsDocument = (payload: unknown): payload is WeightsDocument =>
  isObject(payload) &&
  hasExactKeys(payload, ["record", "mac"]) &&
  typeof payload.mac === "string" &&
  KEY_PATTERN.test(payload.mac) &&
  isWeightsRecord(payload.record);

export const weightsType: DocumentType<WeightsDocument> = {
  name: WEIGHTS_DOCUMENT,
  schemaVersion: 1,
  validate: isWeightsDocument,
};

/** The MAC of a record, bound to the repository's real root, so a set copied from another repository never verifies. */
export const weightsMac = (cache: RepositoryCache, record: WeightsRecord) =>
  recordMac(cache.integrityKey, MAC_DOMAIN, { root: cache.root, record });

/** Whether adaptive weights are on: any `SCOPE_ADAPTIVE` value but `off` leaves them on. */
export const adaptiveEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SCOPE_ADAPTIVE !== "off";

const oneLine = (text: string) => text.replace(/\s+/g, " ").slice(0, 200);

/**
 * The verified active set, or none. Never throws. A document that is unreadable, malformed, out of bound, not signed by
 * this user for this repository, or for another baseline version is ignored with exactly one warning; a missing one is
 * not a problem and adds none. Another baseline's set is stale: it is ignored until `reset-weights`, `clear` or the
 * next promotion removes it.
 */
export async function readActiveWeights(
  cache: RepositoryCache,
  baselineVersion: string = DEFAULT_RETRIEVAL_CONFIG.version,
): Promise<{ record?: WeightsRecord; warnings: string[] }> {
  try {
    const { value, warning } = await cache.store.read(weightsType);
    if (warning) return { warnings: [oneLine(`${WEIGHTS_DOCUMENT}.json: ${warning}; using the baseline weights`)] };
    if (!value) return { warnings: [] };
    if (!macEquals(value.mac, weightsMac(cache, value.record))) {
      return { warnings: [`${WEIGHTS_DOCUMENT}.json: not signed by this user; using the baseline weights`] };
    }
    if (value.record.baselineVersion !== baselineVersion) {
      return {
        warnings: [
          oneLine(
            `${WEIGHTS_DOCUMENT}.json: adaptive weights were set for ${value.record.baselineVersion}, not ${baselineVersion}; ` +
              "using the baseline weights (scope cache reset-weights removes them)",
          ),
        ],
      };
    }
    return { record: value.record, warnings: [] };
  } catch (error) {
    return {
      warnings: [oneLine(`${WEIGHTS_DOCUMENT}.json: ${error instanceof Error ? error.message : String(error)}`)],
    };
  }
}

/** `config` with each weight multiplied by its multiplier and the version naming the set. */
export function applyMultipliers(config: RetrievalConfig, record: WeightsRecord): RetrievalConfig {
  const weights = { ...config.weights };
  for (const name of SIGNAL_NAMES) weights[name] = config.weights[name] * record.multipliers[name];
  return { ...config, weights, version: adaptiveConfigVersion(config.version, record) };
}

/**
 * The retrieval config a run uses: `config` with the active adaptive set applied, or `config` itself. Off for
 * `SCOPE_ADAPTIVE=off` and for a store that was just reset. Never throws; `warnings` say what was ignored.
 */
export async function withAdaptiveWeights(
  cache: RepositoryCache,
  config: RetrievalConfig,
  env?: NodeJS.ProcessEnv,
): Promise<{ config: RetrievalConfig; active?: WeightsRecord; warnings: string[] }> {
  if (!adaptiveEnabled(env) || cache.fresh) return { config, warnings: [] };
  const { record, warnings } = await readActiveWeights(cache);
  return record ? { config: applyMultipliers(config, record), active: record, warnings } : { config, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// proposals

export interface ProposalInput {
  history: readonly HistoryRecord[];
  feedback: readonly FeedbackRecord[];
  /** The current source. */
  chunks: readonly CodeChunk[];
  /** Included text files (default: the files of `chunks`). */
  files?: ReadonlySet<string>;
  /** The baseline to re-score with (default: the baseline config). */
  config?: RetrievalConfig;
}

export interface Proposal {
  multipliers: Multipliers;
  /** Chunks the proposal learned from: confirmed useful, and the reference set they were compared with. */
  samples: { runs: number; useful: number; reference: number };
  /** True when every multiplier is 1: the proposal is the baseline. */
  identity: boolean;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const isIdentity = (multipliers: Multipliers) => SIGNAL_NAMES.every((name) => multipliers[name] === 1);

export const IDENTITY_MULTIPLIERS: Readonly<Multipliers> = Object.freeze({
  symbol: 1,
  lexical: 1,
  path: 1,
  dependency: 1,
  test: 1,
  proximity: 1,
});

/**
 * Proposes multipliers from external feedback only; predictions and Jev scores never enter (#77). For each run with
 * chunks confirmed useful or irrelevant by feedback that still match the current source, the run's stored (redacted)
 * task is re-scored against the current chunks with the baseline config, and each signal's value is read for:
 *   - the useful set: the chunks confirmed useful, and
 *   - the reference set: the chunks confirmed irrelevant; for a run with none, the rest of its baseline shortlist.
 * Per signal the multiplier is `1 + B * clamp(meanUseful - meanReference, -1, 1)` over all runs pooled, with signals
 * in [0, 1] and B = {@link ADAPTIVE_BOUND}, rounded to six decimals: a signal that is stronger on useful chunks than on
 * the reference gains weight, a weaker one loses weight, never beyond the bound. Without confirmed evidence on both
 * sides the proposal is the identity. Pure and deterministic: runs and chunks are visited in sorted order.
 */
export function proposeWeights(input: ProposalInput): Proposal {
  const baseline = input.config ?? DEFAULT_RETRIEVAL_CONFIG;
  const current = new Map(input.chunks.map((chunk) => [chunk.id, contentFingerprint(chunk.content)]));
  const files = input.files ?? new Set(input.chunks.map((chunk) => chunk.file));
  const feedbackByRun = new Map<string, FeedbackRecord[]>();
  for (const record of input.feedback)
    feedbackByRun.set(record.runId, [...(feedbackByRun.get(record.runId) ?? []), record]);

  const useful: number[][] = SIGNAL_NAMES.map(() => []);
  const reference: number[][] = SIGNAL_NAMES.map(() => []);
  let runs = 0;
  let usefulCount = 0;
  let referenceCount = 0;
  const history = [...input.history].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  for (const record of history) {
    const feedback = feedbackByRun.get(record.runId);
    if (!feedback) continue;
    const { chunks: evidence } = collectEvidence([record], feedback, current, files);
    const usefulIds = [...evidence.values()].filter((e) => isConfirmedUseful(e.feedback)).map((e) => e.chunkId);
    const irrelevantIds = [...evidence.values()].filter((e) => isConfirmedIrrelevant(e.feedback)).map((e) => e.chunkId);
    if (usefulIds.length === 0 && irrelevantIds.length === 0) continue;
    const ranked = generateCandidates(record.task.text, input.chunks, baseline);
    const signals = new Map(ranked.map((candidate) => [candidate.chunkId, candidate.signals]));
    const usefulSet = new Set(usefulIds);
    const referenceIds =
      irrelevantIds.length > 0
        ? irrelevantIds
        : record.candidates
            .filter((candidate) => current.get(candidate.chunkId) === candidate.fingerprint)
            .map((candidate) => candidate.chunkId)
            .filter((id) => !usefulSet.has(id))
            .sort();
    runs++;
    usefulCount += usefulIds.length;
    referenceCount += referenceIds.length;
    SIGNAL_NAMES.forEach((name, index) => {
      for (const id of usefulIds) useful[index]!.push(signals.get(id)?.[name] ?? 0);
      for (const id of referenceIds) reference[index]!.push(signals.get(id)?.[name] ?? 0);
    });
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const multipliers = { ...IDENTITY_MULTIPLIERS };
  if (usefulCount > 0 && referenceCount > 0) {
    SIGNAL_NAMES.forEach((name, index) => {
      const difference = clamp(mean(useful[index]!) - mean(reference[index]!), -1, 1);
      multipliers[name] = clamp(round6(1 + ADAPTIVE_BOUND * difference), LOW, HIGH);
    });
  }
  return {
    multipliers,
    samples: { runs, useful: usefulCount, reference: referenceCount },
    identity: isIdentity(multipliers),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// held-out gate

/** What an evaluator reports for one config: tasks evaluated and the recall counts over their required labels. */
export interface RecallMeasure extends RecallCount {
  tasks: number;
}

/**
 * Evaluates the baseline and a proposal with `evaluator`, a callback so that this module never reads labeled tasks.
 * The evaluator must run retrieval only (never `runScope`), so held-out task text and labels are never recorded.
 */
export async function evaluateProposal(
  multipliers: Multipliers,
  evaluator: (config: RetrievalConfig) => Promise<RecallMeasure> | RecallMeasure,
  baseline: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): Promise<Evaluation> {
  const record: WeightsRecord = {
    recordVersion: WEIGHTS_RECORD_VERSION,
    version: adaptiveVersion(baseline.version, multipliers),
    baselineVersion: baseline.version,
    multipliers,
    promotedAt: 0,
    evaluation: { tasks: 0, baseline: { found: 0, total: 0 }, proposal: { found: 0, total: 0 } },
  };
  const before = await evaluator(baseline);
  const after = await evaluator(applyMultipliers(baseline, record));
  return {
    tasks: before.tasks,
    baseline: { found: before.found, total: before.total },
    proposal: { found: after.found, total: after.total },
  };
}

export type PromotionDecision = { promote: true } | { promote: false; reason: string };

const share = (count: RecallCount) => `${count.found}/${count.total}`;

/**
 * The gate. A proposal is promoted only when it changes the baseline, at least one held-out task was evaluated and its
 * held-out recall is strictly greater than the baseline's on the same labels. Equal or lower recall, no tasks and a
 * malformed evaluation are all refused with a reason.
 */
export function judgePromotion(multipliers: unknown, evaluation: unknown): PromotionDecision {
  if (!isMultipliers(multipliers)) {
    return { promote: false, reason: `multipliers must be finite and within ${LOW} to ${HIGH}` };
  }
  if (!isEvaluation(evaluation)) return { promote: false, reason: "the evaluation result is malformed" };
  if (isIdentity(multipliers)) return { promote: false, reason: "no change: the proposal equals the baseline" };
  if (evaluation.tasks <= 0 || evaluation.baseline.total <= 0) {
    return { promote: false, reason: "no held-out tasks were evaluated" };
  }
  if (evaluation.proposal.total !== evaluation.baseline.total) {
    return { promote: false, reason: "baseline and proposal were evaluated on different labels" };
  }
  if (evaluation.proposal.found <= evaluation.baseline.found) {
    return {
      promote: false,
      reason: `held-out recall ${share(evaluation.proposal)} does not beat the baseline's ${share(evaluation.baseline)}`,
    };
  }
  return { promote: true };
}

export type PromotionOutcome = { promoted: true; record: WeightsRecord } | { promoted: false; reason: string };

/**
 * Promotes a proposal through the gate: writes `weights-active` (replacing any earlier set, current or stale) only when
 * {@link judgePromotion} allows it, and otherwise writes nothing and says why. Never throws.
 */
export async function promoteWeights(
  cache: RepositoryCache,
  multipliers: Multipliers,
  evaluation: Evaluation,
  options: { now?: number } = {},
): Promise<PromotionOutcome> {
  const decision = judgePromotion(multipliers, evaluation);
  if (!decision.promote) return { promoted: false, reason: decision.reason };
  const baselineVersion = DEFAULT_RETRIEVAL_CONFIG.version;
  const now = options.now ?? Date.now();
  const record: WeightsRecord = {
    recordVersion: WEIGHTS_RECORD_VERSION,
    version: adaptiveVersion(baselineVersion, multipliers),
    baselineVersion,
    multipliers: { ...multipliers },
    promotedAt: now,
    evaluation: {
      tasks: evaluation.tasks,
      baseline: { ...evaluation.baseline },
      proposal: { ...evaluation.proposal },
    },
  };
  const outcome = await commitRepositoryCache(
    cache,
    (tx) => tx.write(weightsType, { record, mac: weightsMac(cache, record) }),
    {
      now,
    },
  );
  return outcome.committed
    ? { promoted: true, record }
    : { promoted: false, reason: `not written: ${outcome.warning}` };
}
