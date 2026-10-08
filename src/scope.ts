import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AnalysisCache, analysisKey, contentHash, type StatInfo } from "./cache/analysis.ts";
import { openRepositoryCache } from "./cache/location.ts";
import type { VersionKeys } from "./cache/versions.ts";
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
  /**
   * Reuse and store per-file analysis in `<repo>/.scope/` (default: false, so library callers and tests never write
   * into a repository unless they ask). Output is identical either way; cache problems only add warnings.
   */
  cache?: boolean;
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
  {
    detailed = false,
    signal,
    cache,
  }: {
    detailed?: boolean;
    signal?: AbortSignal;
    /** Turns the analysis cache on; undefined means off. `keys` is a test seam for the version keys. */
    cache?: {
      keys?: VersionKeys;
      integrityEnv?: NodeJS.ProcessEnv;
      /** Test seams for the stat records: the clock and the racy-file margin. */
      now?: () => number;
      racyMarginMs?: number;
      /** Ignore every cached analysis and stat record and rewrite the analysis data (`scope cache rebuild`). */
      rebuild?: boolean;
    };
  } = {},
): Promise<{
  chunks: CodeChunk[];
  warnings: string[];
  /**
   * `reused` counts every file served from the cache: `statHits` were not even read, `renamed` came from another path.
   * `analyzed` files were parsed.
   */
  analysis?: { reused: number; analyzed: number; statHits: number; renamed: number };
  /** With the cache on: whether this run's commit reached the store (false when it was skipped or failed). */
  cacheCommitted?: boolean;
}> {
  const { root } = resolveRepository(repo);
  const chunks: CodeChunk[] = [];
  const textOnly: string[] = [];
  const { files, warnings } = await scanRepository(root, {}, signal);
  let analysisCache: AnalysisCache | undefined;
  const openWarnings: string[] = [];
  if (cache) {
    const opened = await openRepositoryCache(root, { keys: cache.keys, integrityEnv: cache.integrityEnv });
    openWarnings.push(...opened.warnings);
    if (opened.cache) {
      analysisCache = new AnalysisCache(opened.cache, opened.warnings, {
        now: cache.now,
        racyMarginMs: cache.racyMarginMs,
        rebuild: cache.rebuild,
      });
    }
  }
  let reused = 0;
  let analyzed = 0;
  let statHits = 0;
  let renamed = 0;
  const take = (file: string, analysis: { chunks: CodeChunk[]; warnings: string[]; textOnly: boolean }) => {
    chunks.push(...analysis.chunks);
    if (analysis.textOnly) textOnly.push(file);
    else warnings.push(...analysis.warnings);
  };
  for (const file of files) {
    if (signal?.aborted) throw new CancelledError();
    // The stat is taken before the file is read, so a write in between leaves a record that no longer matches.
    const statAt = analysisCache?.now() ?? 0;
    const info: StatInfo | undefined = analysisCache
      ? await stat(join(root, file)).then(
          ({ size, mtimeMs, ctimeMs, ino }) => ({ size, mtimeMs, ctimeMs, ino }),
          () => undefined,
        )
      : undefined;
    const fast = info ? await analysisCache?.fast(file, info) : undefined;
    if (fast) {
      reused++;
      statHits++;
      take(file, fast);
      continue;
    }
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
    const key = analysisKey(file, bytes);
    const hash = analysisCache ? contentHash(bytes) : "";
    let analysis = await analysisCache?.lookup(file, key);
    if (analysis) reused++;
    else if ((analysis = await analysisCache?.renamed(file, key, hash, text.slice(0, HEAD_CHARS)))) {
      reused++;
      renamed++;
    } else {
      const result = await analyzeFile({ path: file, source: redactSecrets(text) }, language);
      analysis = { chunks: result.chunks, warnings: result.warnings, textOnly: result.textOnly === true };
      analysisCache?.record(file, key, analysis);
      analyzed++;
    }
    if (info) await analysisCache?.note(file, info, key, hash, statAt);
    take(file, analysis);
  }
  const summary = textOnlySummary(textOnly, detailed);
  if (summary) warnings.push(summary);
  if (!cache) return { chunks, warnings };
  if (signal?.aborted) throw new CancelledError();
  const outcome = await analysisCache?.commit();
  // Cache problems (open, read, commit) come last and once each, so the rest of the warnings match an uncached run.
  const cacheWarnings = analysisCache ? analysisCache.warnings : openWarnings;
  return {
    chunks,
    warnings: [...warnings, ...cacheWarnings],
    analysis: { reused, analyzed, statHits, renamed },
    // An unchanged warm run takes no lock and commits nothing (undefined), which is fine; only a failed commit is false.
    cacheCommitted: analysisCache !== undefined && outcome?.committed !== false,
  };
}

/** Scans the repository and shortlists candidates; shared by the real run and the payload preview. */
async function prepareCandidates(
  task: string,
  repo: string,
  detailed: boolean,
  signal: AbortSignal | undefined,
  cache?: { keys?: VersionKeys },
) {
  if (!task.trim()) throw new UsageError("A task description is required.");
  const { chunks, warnings } = await loadChunks(repo, { detailed, signal, cache });
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
  } = await prepareCandidates(task, repo, explain, signal, options.cache ? {} : undefined);
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
