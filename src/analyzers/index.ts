import type { AnalysisResult, Analyzer, Language, SourceFile, TokenEstimator } from "../types.ts";
import { configAnalyzer } from "./config.ts";
import { ecmascriptAnalyzer } from "./ecmascript.ts";
import { markdownAnalyzer } from "./markdown.ts";
import { pythonAnalyzer } from "./python.ts";
import { sqlAnalyzer } from "./sql.ts";

const ANALYZERS: readonly Analyzer[] = [
  ecmascriptAnalyzer,
  pythonAnalyzer,
  markdownAnalyzer,
  configAnalyzer,
  sqlAnalyzer,
];

const byLanguage = new Map<Language, Analyzer>(
  ANALYZERS.flatMap((analyzer) => analyzer.languages.map((language) => [language, analyzer] as const)),
);

/** The analyzer registered for a language, or undefined when none is. */
export function analyzerFor(language: Language): Analyzer | undefined {
  return byLanguage.get(language);
}

/** Analyzes a file with the analyzer for its language; throws when the language has no analyzer. */
export async function analyzeFile(
  file: SourceFile,
  language: Language,
  estimator: TokenEstimator,
): Promise<AnalysisResult> {
  const analyzer = analyzerFor(language);
  if (!analyzer) throw new Error(`No analyzer is registered for language "${language}" (${file.path}).`);
  return analyzer.analyze(file, estimator, language);
}
