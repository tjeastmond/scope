import type { AnalysisResult, Analyzer, CodeChunk, Language, SourceFile, TokenEstimator } from "../types.ts";
import { configAnalyzer } from "./config.ts";
import { ecmascriptAnalyzer } from "./ecmascript.ts";
import { markdownAnalyzer } from "./markdown.ts";
import { markupAnalyzer } from "./markup.ts";
import { pythonAnalyzer } from "./python.ts";
import { sqlAnalyzer } from "./sql.ts";
import { styleAnalyzer } from "./style.ts";
import { textFallback } from "./text.ts";

const ANALYZERS: readonly Analyzer[] = [
  ecmascriptAnalyzer,
  pythonAnalyzer,
  markdownAnalyzer,
  configAnalyzer,
  sqlAnalyzer,
  markupAnalyzer,
  styleAnalyzer,
];

const byLanguage = new Map<Language, Analyzer>(
  ANALYZERS.flatMap((analyzer) => analyzer.languages.map((language) => [language, analyzer] as const)),
);

/** The analyzer registered for a language, or undefined when none is. */
export function analyzerFor(language: Language): Analyzer | undefined {
  return byLanguage.get(language);
}

/** A failure message reduced to one bounded line, so a parser error never floods the warnings. */
function briefly(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The warning for a file with a NUL byte, which is never analyzed or sent. */
export const binaryWarning = (path: string): string => `${path}: binary content (NUL byte); skipped`;

/**
 * Analyzes a file with the analyzer for its language and guarantees usable chunks anyway. A file with a NUL byte is
 * binary: it is not analyzed, gets no chunks and a warning. A language with no analyzer, an analyzer that throws, or
 * one that extracts nothing from non-blank source falls back to text windows over the whole file; an analyzer that
 * recovered chunks from a file with syntax errors keeps them and gets text windows over the uncovered lines only.
 */
export async function analyzeFile(
  file: SourceFile,
  language: Language,
  estimator: TokenEstimator,
): Promise<AnalysisResult> {
  if (file.source.includes("\0")) return { chunks: [], warnings: [binaryWarning(file.path)] };
  const analyzer = analyzerFor(language);
  const fallback = (reason: string, covered: readonly CodeChunk[] = []) =>
    textFallback(file.path, file.source, language, estimator, reason, covered);
  if (!analyzer) return fallback(`no analyzer for language "${language}"`);
  let analysis: AnalysisResult;
  try {
    analysis = await analyzer.analyze(file, estimator, language);
  } catch (error) {
    return fallback(`analyzer failed (${briefly(error)})`);
  }
  if (!analysis.partial && analysis.chunks.length > 0) return analysis;
  const filled = fallback(analysis.partial ? "syntax errors" : "analyzer extracted no chunks", analysis.chunks);
  return {
    chunks: [...analysis.chunks, ...filled.chunks].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine),
    warnings: [...analysis.warnings, ...filled.warnings],
    ...(analysis.partial ? { partial: true } : {}),
  };
}
