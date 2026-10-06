// Contracts of the repository graph (M3). Edges are derived from chunk `references` and test naming; see
// docs/graph-limitations.md for what is and is not resolved.
import type { Language, Reference, ReferenceEvidence } from "../types.ts";

/** One relationship between chunks, or from a chunk to a file or to nothing (a dangling, unresolved reference). */
export interface GraphEdge {
  kind: Reference["kind"] | "test";
  /** Chunk the relationship starts at. File-level relationships are anchored on the first chunk of the file. */
  from: string;
  fromFile: string;
  /** Target chunk, when one was found. */
  to?: string;
  /** Target file, when the reference resolved to one (set for chunk targets too). */
  toFile?: string;
  /** Name as written in the reference (a file path for `test` edges). */
  name: string;
  specifier?: string;
  confidence: ReferenceEvidence;
  /** Human-readable account of how the edge was found, or why it is unresolved. */
  evidence: string;
}

export type ImportResolution = { file: string; via?: string } | { unresolved: string };

/** Maps an import specifier, as written in `from.file`, to a scanned file or says why it cannot. */
export type ImportResolver = (from: { file: string; language: Language }, specifier: string) => ImportResolution;

export type NeighborConfidence = Exclude<ReferenceEvidence, "unresolved">;

/** A chunk one hop away over resolved chunk-level edges, in either direction. */
export interface Neighbor {
  chunkId: string;
  /** The best confidence among the edges that connect the two chunks. */
  confidence: NeighborConfidence;
  /** Evidence of that best edge. */
  evidence: string;
}

export interface FileImport {
  file: string;
  confidence: NeighborConfidence;
  evidence: string;
}

export interface RepositoryGraph {
  /** Every edge, in a deterministic total order. Unresolved references are included as dangling edges. */
  readonly edges: readonly GraphEdge[];
  outgoing(chunkId: string): readonly GraphEdge[];
  /** Edges whose `to` is this chunk. */
  incoming(chunkId: string): readonly GraphEdge[];
  /** Sorted: exact before heuristic, then file, start line and id. Never capped; callers bound it. */
  neighbors(chunkId: string): Neighbor[];
  /** Files this file imports (resolved edges only), deduplicated and sorted by path. */
  fileImports(file: string): FileImport[];
  /** Test files linked to a source file (sorted). */
  testsFor(file: string): string[];
  /** Source files a test file is linked to (sorted). */
  sourcesFor(testFile: string): string[];
}
