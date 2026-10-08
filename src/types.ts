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
  /** Id of the container (class or namespace header) chunk this chunk belongs to; see docs/chunk-model.md. */
  parentId?: string;
  /** Name of that container. Present exactly when `parentId` is. */
  containerName?: string;
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
  /** The language has no analyzer, so the text fallback was expected, not a problem; callers may summarize it. */
  textOnly?: true;
}

/** Turns one source file into normalized chunks. Async because Tree-sitter initialization is. */
export interface Analyzer {
  readonly languages: readonly Language[];
  /** `language` is the one the dispatcher resolved, which can differ from the path alone (a shebang script). */
  analyze(file: SourceFile, language: Language): Promise<AnalysisResult>;
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

/** One request sent to Jev: its own latency and the token usage Jev returned for it. */
export interface JevRequestMetrics {
  /** Milliseconds from just before the request was sent to its answer (whole milliseconds). */
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult {
  /** Exactly one judgment per candidate, in candidate order. */
  judgments: RelevanceJudgment[];
  /** Total tokens Jev reported, summed over every request. */
  usage?: JevUsage;
  /** Wall clock of the whole decision. Requests run concurrently, so this is not the sum of the per-request latencies. */
  latencyMs?: number;
  /** One entry per request sent, in request (plan) order, not completion order. */
  requests?: JevRequestMetrics[];
}

/** Jev's external-service overhead for one run, reported separately from the selected context. No monetary cost. */
export interface JevMetrics {
  /** Requests sent; present only when the provider reported per-request metrics. */
  requestCount?: number;
  /** Wall clock of the whole Jev decision in milliseconds (concurrent requests overlap). */
  latencyMs: number;
  /** Tokens as reported by Jev, summed over every request. */
  usage: { inputTokens: number; outputTokens: number };
  /** `--explain` only: each request's own latency and usage, in request order. */
  requests?: JevRequestMetrics[];
}

/** Implemented by the real Jev adapter and by the fake provider used in tests. */
export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /**
   * Material that fully identifies the request payload and configuration this provider would use for these
   * candidates, or undefined to opt out. A provider without this method (or returning undefined) never reads or
   * writes the decision cache.
   */
  decisionCacheKey?(task: string, candidates: readonly CodeChunk[]): unknown;
}

export type ScopeMode = "jev" | "no-jev";

export interface SelectedChunk {
  chunk: CodeChunk;
  /** Deterministic ranking signals by name (empty when none were computed). */
  signals: Record<string, number>;
  /** How retrieval found the chunk: `direct` (matched the task) or `expanded-from:<chunk id>` (a graph neighbour). */
  origin?: string;
  /** Jev relevance, absent in `no-jev` mode. */
  relevance?: number;
  /** Ranking score used for selection; not a probability. */
  score: number;
  reason: string;
  /** Ids of the selected chunks that required this one; present only when it was pulled in as a support. */
  supportFor?: string[];
}

/** A candidate that scored below the relevance minimum and so was not included (docs/selection-policy.md). */
export interface SkippedChunk {
  chunkId: string;
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  name?: string;
  /** Jev relevance, absent in `no-jev` mode. */
  relevance?: number;
  /** Ranking score used for selection; not a probability. */
  score: number;
}

/** An emitted block of source: the union of adjacent, overlapping or nested selected chunks of one file. */
export interface ScopeRegion {
  file: string;
  language: Language;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  content: string;
  /** Ids of the selected chunks merged into this region, sorted by start line then id. */
  chunkIds: string[];
}

export interface ScopeResult {
  schemaVersion: 2;
  mode: ScopeMode;
  task: string;
  /** Per-chunk selection provenance. */
  chunks: SelectedChunk[];
  /** What is printed: `chunks` merged so no line appears twice. */
  regions: ScopeRegion[];
  warnings: string[];
  /** Candidates that scored below the relevance minimum, sorted by file, start line, then id. */
  skipped: SkippedChunk[];
  /** Version of the retrieval weights and caps that prepared the candidates. */
  retrievalConfigVersion?: string;
  /** Version of the Jev question text and criteria; absent in `no-jev` mode. */
  jevQuestionVersion?: string;
  /** Jev's latency and token usage; absent in `no-jev` mode and when Jev was not called. */
  jev?: JevMetrics;
  /** ISO 8601 UTC time of the stored Jev decision this run reused (identical task, candidates and versions); absent on a fresh decision. */
  decisionsReusedFrom?: string;
  /**
   * Id of the run's history record (#73), the handle for `scope feedback` (#76). On a reused decision it is the id of
   * the run that made the decision, only while that run's history record still exists. Absent for `--no-jev`, with the
   * cache off, with no candidates, and when no record was committed.
   */
  runId?: string;
  /** Set by `--explain`: renderers add the selection evidence. */
  explain?: true;
}
