import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeFile } from "./analyzers/index.ts";
import { TYPESCRIPT_EXTENSIONS } from "./analyzers/typescript.ts";
import { DEFAULT_BUDGET } from "./config.ts";
import { selectWithinBudget } from "./context/select.ts";
import { charsPerTokenEstimator } from "./context/tokens.ts";
import { JevDecisionProvider } from "./jev/provider.ts";
import { validateJudgments } from "./jev/validate.ts";
import { listFiles } from "./repository/files.ts";
import { redactSecrets } from "./repository/redact.ts";
import { selectCandidates } from "./retrieval/candidates.ts";
import type { CodeChunk, DecisionProvider, DecisionResult, ScopeResult, SelectedChunk } from "./types.ts";

export interface ScopeOptions {
  task: string;
  /** Repository root (default: current directory). */
  repo?: string;
  /** Estimated token budget for the output. */
  budget?: number;
  /** Explicit offline baseline: every candidate is kept at full score, and Jev is never contacted. */
  noJev?: boolean;
  /** Decision provider for the Jev path; defaults to the real Jev adapter. Tests inject a fake. */
  provider?: DecisionProvider;
  signal?: AbortSignal;
}

export interface ScopeRun {
  result: ScopeResult;
  /** Present only when Jev judged the candidates (usage, latency). */
  decision?: DecisionResult;
}

/** A problem with how Scope was invoked (bad path, bad budget), as opposed to a failure while running. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

async function loadChunks(repo: string): Promise<CodeChunk[]> {
  const info = await stat(repo).catch(() => undefined);
  if (!info?.isDirectory()) throw new UsageError(`--repo is not a directory: ${repo}`);
  const chunks: CodeChunk[] = [];
  for (const file of await listFiles(repo, TYPESCRIPT_EXTENSIONS)) {
    const bytes = await readFile(join(repo, file));
    if (bytes.includes(0)) continue; // NUL bytes mean binary content, which is never parsed or sent
    const source = redactSecrets(bytes.toString("utf8"));
    chunks.push(...(await analyzeFile({ path: file, source }, "typescript", charsPerTokenEstimator)).chunks);
  }
  return chunks;
}

/** Orchestrates a Scope run. Callable without argument parsing; the CLI only parses args and calls this. */
export async function runScope(options: ScopeOptions): Promise<ScopeRun> {
  const { task, repo = ".", budget = DEFAULT_BUDGET, noJev = false, signal } = options;
  if (!task.trim()) throw new UsageError("A task description is required.");
  if (!Number.isInteger(budget) || budget <= 0) throw new UsageError(`--budget must be a positive integer: ${budget}`);

  const candidates = selectCandidates(await loadChunks(resolve(repo)));
  const mode = noJev ? "no-jev" : "jev";
  // The Jev provider (and so the SDK client and its credential check) is only built on the Jev path.
  const decision = noJev
    ? undefined
    : await (options.provider ?? new JevDecisionProvider()).decide({ task, candidates, signal });

  const relevance = decision ? validateJudgments(candidates, decision.judgments) : new Map<string, number>();
  const scored: SelectedChunk[] = candidates.map((chunk) => {
    const value = relevance.get(chunk.id);
    return {
      chunk,
      signals: {},
      relevance: value,
      score: value ?? 1,
      reason: value === undefined ? "Offline baseline: all candidates" : `Jev relevance ${value.toFixed(2)}`,
    };
  });

  const result = selectWithinBudget(scored, { task, mode, budget, estimator: charsPerTokenEstimator });
  return { result, decision };
}
