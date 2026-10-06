// Shared contracts for Scope. Source records (CodeChunk) are kept separate from retrieval scores and selection
// reasons (SelectedChunk, ScopeResult). Scores are ranking signals, not calibrated probabilities.

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "sql"
  | "html"
  | "css"
  | "scss"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "text";

export type ChunkKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "component"
  | "query"
  | "table"
  | "style"
  | "template"
  | "config"
  | "section"
  | "file";

export interface SourceLocation {
  file: string;
  /** 1-based, inclusive. */
  line: number;
}

/** How a reference target was determined. Uncertainty is recorded, never guessed away; see docs/chunk-model.md. */
export type ReferenceEvidence = "exact" | "heuristic" | "unresolved";

export interface Reference {
  kind: "import" | "call" | "type" | "extends" | "implements" | "style" | "test";
  /** Where the reference occurs. */
  from: SourceLocation;
  /** Name as written in source. For imports: see "References" in docs/chunk-model.md. */
  name: string;
  /** Raw module specifier of an import as written (`"./retry.ts"`, `"..pkg"`); never resolved. Absent when dynamic. */
  specifier?: string;
  /** Import only: the name the file binds when it differs from `name` (`b` in `import { a as b }`). */
  local?: string;
  /** Import only: the binding is the whole module (`import * as ns`, Python `import a.b`), not a symbol in it. */
  namespace?: true;
  /** Chunk the reference resolves to, when known. */
  targetChunkId?: string;
  /** Absent means no resolution was attempted; consumers treat that like "unresolved". */
  evidence?: ReferenceEvidence;
}

export interface CodeChunk {
  /** Stable for unchanged source; see `makeChunkId`. */
  id: string;
  /** Repository-relative path with `/` separators. */
  file: string;
  language: Language;
  kind: ChunkKind;
  name?: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  content: string;
  references: Reference[];
  estimatedTokens: number;
  /** Id of the container (class or namespace header) chunk this chunk belongs to; see docs/chunk-model.md. */
  parentId?: string;
  /** Name of that container. Present exactly when `parentId` is. */
  containerName?: string;
}

export interface TokenEstimator {
  /** Identity reported in results so estimates can be compared. */
  readonly id: string;
  count(text: string): number;
}

export interface SourceFile {
  /** Repository-relative path with `/` separators. */
  path: string;
  source: string;
}

export interface AnalysisResult {
  chunks: CodeChunk[];
  /** Non-fatal problems (for example a file that only partly parsed). */
  warnings: string[];
  /** Set when the file had syntax errors and the chunks cover only what the parser recovered. */
  partial?: boolean;
}

/** Turns one source file into normalized chunks. Async because Tree-sitter initialization is. */
export interface Analyzer {
  readonly languages: readonly Language[];
  /** `language` is the one the dispatcher resolved, which can differ from the path alone (a shebang script). */
  analyze(file: SourceFile, estimator: TokenEstimator, language: Language): Promise<AnalysisResult>;
}

export interface JevUsage {
  [field: string]: number | undefined;
}

export interface RelevanceJudgment {
  chunkId: string;
  /** Finite, within [0, 1]. */
  relevance: number;
  /** Raw provider answer, kept for evidence and debugging. */
  raw?: unknown;
}

export interface DecisionRequest {
  task: string;
  candidates: readonly CodeChunk[];
  /** Caller-owned cancellation and overall deadline. */
  signal?: AbortSignal;
}

export interface DecisionResult {
  /** Exactly one judgment per candidate, in candidate order. */
  judgments: RelevanceJudgment[];
  usage?: JevUsage;
  latencyMs?: number;
}

/** Implemented by the real Jev adapter and by the fake provider used in tests. */
export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export type ScopeMode = "jev" | "no-jev";

export interface SelectedChunk {
  chunk: CodeChunk;
  /** Deterministic ranking signals by name (empty when none were computed). */
  signals: Record<string, number>;
  /** Jev relevance, absent in `no-jev` mode. */
  relevance?: number;
  /** Ranking score used for selection; not a probability. */
  score: number;
  reason: string;
}

export interface ScopeResult {
  schemaVersion: 1;
  mode: ScopeMode;
  task: string;
  budget: number;
  estimator: string;
  /** Estimate of the full serialized artifact. */
  estimatedTokens: number;
  characters: number;
  lines: number;
  chunks: SelectedChunk[];
  warnings: string[];
}
