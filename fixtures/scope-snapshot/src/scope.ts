import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFile, binaryWarning, textOnlySummary } from "./analyzers/index.ts";
import { CancelledError, UsageError } from "./errors.ts";
import { JEV_QUESTION_VERSION } from "./config.ts";
import { selectByRelevance } from "./context/select.ts";
import { JevDecisionProvider, planJevRequests, type JevRequest } from "./jev/provider.ts";
import { validateJudgments } from "./jev/validate.ts";
import { scanRepository } from "./repository/files.ts";
import { classifyFile } from "./repository/language.ts";
import { redactSecrets } from "./repository/redact.ts";
import { resolveRepository } from "./repository/root.ts";
import { selectCandidates } from "./retrieval/candidates.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "./retrieval/config.ts";
import type { CodeChunk, DecisionProvider, DecisionResult, JevMetrics, ScopeResult, SelectedChunk } from "./types.ts";

export interface ScopeOptions {
  task: string;
  /** Repository root (default: current directory). */
  repo?: string;
  /** Explicit offline baseline: every candidate is kept at full score, and Jev is never contacted. */
  noJev?: boolean;
  /** Decision provider for the Jev path; defaults to the real Jev adapter. Tests inject a fake. */
  provider?: DecisionProvider;
  /** Include selection evidence in the artifact. */
  explain?: boolean;
  /** Aborted when the user cancels: stops the scan and the Jev request with a CancelledError or JevCancelledError. */
  signal?: AbortSignal;
}

export interface ScopeRun {
  result: ScopeResult;
  /** Present only when Jev judged the candidates (usage, latency). */
  decision?: DecisionResult;
}

export { UsageError };

const NO_CHUNKS_WARNING = "No candidate chunks were found in the repository.";

/** How much of a file the classifier sees, enough for a shebang line and a text check. */
const HEAD_CHARS = 1024;

/**
 * Scans and analyzes the repository. Files read as plain text only because their language has no analyzer are expected,
 * so they get one summary warning (`detailed` lists more of them); every other fallback still warns per file.
 */
export async function loadChunks(
  repo: string,
  { detailed = false, signal }: { detailed?: boolean; signal?: AbortSignal } = {},
): Promise<{ chunks: CodeChunk[]; warnings: string[] }> {
  const { root } = resolveRepository(repo);
  const chunks: CodeChunk[] = [];
  const textOnly: string[] = [];
  const { files, warnings } = await scanRepository(root, {}, signal);
  for (const file of files) {
    if (signal?.aborted) throw new CancelledError();
    const bytes = await readFile(join(root, file));
    // The scanner only sniffs the start of a file; a NUL anywhere means binary content. Check the raw bytes, because
    // redaction could remove a NUL inside a credential-like literal. Files that do not look like text have no language.
    if (bytes.includes(0)) {
      warnings.push(binaryWarning(file));
      continue;
    }
    const text = bytes.toString("utf8");
    const { language } = classifyFile(file, text.slice(0, HEAD_CHARS));
    if (!language) continue;
    const source = redactSecrets(text);
    const analysis = await analyzeFile({ path: file, source }, language);
    chunks.push(...analysis.chunks);
    if (analysis.textOnly) textOnly.push(file);
    else warnings.push(...analysis.warnings);
  }
  const summary = textOnlySummary(textOnly, detailed);
  if (summary) warnings.push(summary);
  return { chunks, warnings };
}

/** Scans the repository and shortlists candidates; shared by the real run and the payload preview. */
async function prepareCandidates(task: string, repo: string, detailed: boolean, signal: AbortSignal | undefined) {
  if (!task.trim()) throw new UsageError("A task description is required.");
  const { chunks, warnings } = await loadChunks(repo, { detailed, signal });
  // Checked here too so a Ctrl-C during the scan stops the offline path, which never reaches the Jev provider.
  if (signal?.aborted) throw new CancelledError();
  return { chunks, scanWarnings: warnings, ...selectCandidates(task, chunks) };
}

/**
 * Scans and shortlists exactly like `runScope`, then returns the request bodies the Jev path would send, without
 * constructing a client or sending anything.
 */
export async function previewJevPayload(options: {
  task: string;
  repo?: string;
  signal?: AbortSignal;
}): Promise<{ requests: JevRequest[]; candidateCount: number }> {
  const { task, repo = ".", signal } = options;
  const { candidates } = await prepareCandidates(task, repo, false, signal);
  return { requests: planJevRequests(task, candidates), candidateCount: candidates.length };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Jev's overhead from what the provider reported. Nothing is invented: without both totals and a latency there is no
 * `jev` key, and malformed per-request entries are dropped. Per-request detail is only kept under `--explain`.
 */
function jevMetrics(decision: DecisionResult | undefined, explain: boolean): { jev?: JevMetrics } {
  if (!decision) return {};
  const { usage, latencyMs, requests } = decision;
  if (!isCount(usage?.inputTokens) || !isCount(usage?.outputTokens) || !isCount(latencyMs)) return {};
  const perRequest = requests?.every((r) => isCount(r?.latencyMs) && isCount(r.inputTokens) && isCount(r.outputTokens))
    ? requests
    : undefined;
  return {
    jev: {
      ...(perRequest === undefined ? {} : { requestCount: perRequest.length }),
      latencyMs,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      ...(explain && perRequest !== undefined ? { requests: perRequest } : {}),
    },
  };
}

/** Orchestrates a Scope run. Callable without argument parsing; the CLI only parses args and calls this. */
export async function runScope(options: ScopeOptions): Promise<ScopeRun> {
  const { task, repo = ".", noJev = false, explain = false, signal } = options;
  const {
    chunks,
    scanWarnings,
    candidates,
    ranking,
    warning: retrievalWarning,
  } = await prepareCandidates(task, repo, explain, signal);
  const mode = noJev ? "no-jev" : "jev";
  // The Jev provider (and so the SDK client and its credential check) is only built on the Jev path.
  // With nothing to judge Jev is skipped; selection then returns an empty artifact carrying retrieval's guidance.
  const decision =
    noJev || candidates.length === 0
      ? undefined
      : await (options.provider ?? new JevDecisionProvider()).decide({ task, candidates, signal });

  const relevance = decision ? validateJudgments(candidates, decision.judgments) : new Map<string, number>();
  const scored: SelectedChunk[] = candidates.map((chunk) => {
    const value = relevance.get(chunk.id);
    const found = ranking.get(chunk.id);
    return {
      chunk,
      signals: found?.signals ?? {},
      origin: found?.origin,
      relevance: value,
      score: value ?? 1,
      reason: value === undefined ? "Offline baseline: all candidates" : `Jev relevance ${value.toFixed(2)}`,
    };
  });

  // Scan and retrieval warnings and the config version are part of the emitted artifact, so selection can carry them.
  const result = selectByRelevance(scored, {
    task,
    mode,
    explain,
    chunks: new Map(chunks.map((chunk) => [chunk.id, chunk])),
    leadingWarnings: [
      ...scanWarnings,
      ...(retrievalWarning ? [retrievalWarning] : candidates.length === 0 ? [NO_CHUNKS_WARNING] : []),
    ],
    retrievalConfigVersion: DEFAULT_RETRIEVAL_CONFIG.version,
    ...(mode === "jev" ? { jevQuestionVersion: JEV_QUESTION_VERSION } : {}),
  });
  return { result: { ...result, ...jevMetrics(decision, explain) }, decision };
}
