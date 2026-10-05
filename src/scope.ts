import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFile, binaryWarning } from "./analyzers/index.ts";
import { DEFAULT_BUDGET } from "./config.ts";
import { UsageError } from "./errors.ts";
import { selectWithinBudget } from "./context/select.ts";
import { charsPerTokenEstimator } from "./context/tokens.ts";
import { JevDecisionProvider } from "./jev/provider.ts";
import { validateJudgments } from "./jev/validate.ts";
import { scanRepository } from "./repository/files.ts";
import { classifyFile } from "./repository/language.ts";
import { redactSecrets } from "./repository/redact.ts";
import { resolveRepository } from "./repository/root.ts";
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

export { UsageError };

/** How much of a file the classifier sees, enough for a shebang line and a text check. */
const HEAD_CHARS = 1024;

async function loadChunks(repo: string): Promise<{ chunks: CodeChunk[]; warnings: string[] }> {
  const { root } = resolveRepository(repo);
  const chunks: CodeChunk[] = [];
  const { files, warnings } = await scanRepository(root);
  for (const file of files) {
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
    const analysis = await analyzeFile({ path: file, source }, language, charsPerTokenEstimator);
    chunks.push(...analysis.chunks);
    warnings.push(...analysis.warnings);
  }
  return { chunks, warnings };
}

/** Orchestrates a Scope run. Callable without argument parsing; the CLI only parses args and calls this. */
export async function runScope(options: ScopeOptions): Promise<ScopeRun> {
  const { task, repo = ".", budget = DEFAULT_BUDGET, noJev = false, signal } = options;
  if (!task.trim()) throw new UsageError("A task description is required.");
  if (!Number.isInteger(budget) || budget <= 0) throw new UsageError(`--budget must be a positive integer: ${budget}`);

  const { chunks, warnings: scanWarnings } = await loadChunks(repo);
  const candidates = selectCandidates(chunks);
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

  const selected = selectWithinBudget(scored, { task, mode, budget, estimator: charsPerTokenEstimator });
  const result = { ...selected, warnings: [...scanWarnings, ...selected.warnings] };
  return { result, decision };
}
