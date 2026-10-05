// Shared contracts for Scope. Source records (CodeChunk) are kept separate from retrieval scores and selection
// reasons (SelectedChunk, ScopeResult). Scores are ranking signals, not calibrated probabilities.

export type Language = "typescript" | "javascript" | "python" | "go" | "java" | "rust" | "markdown" | "text";

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

export interface Reference {
  kind: "import" | "call" | "type" | "extends" | "implements" | "test";
  /** Where the reference occurs. */
  from: SourceLocation;
  /** Name as written in source. */
  name: string;
  /** Chunk the reference resolves to, when known. */
  targetChunkId?: string;
  /** How the target was resolved (for example "same-file", "import", "name-match"). */
  evidence?: string;
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
}

export interface TokenEstimator {
  /** Identity reported in results so estimates can be compared. */
  readonly id: string;
  count(text: string): number;
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
