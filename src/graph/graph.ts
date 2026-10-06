import type { CodeChunk, ReferenceEvidence } from "../types.ts";
import { importEdges } from "./imports.ts";
import { testEdges } from "./tests.ts";
import type { FileImport, GraphEdge, ImportResolver, Neighbor, NeighborConfidence, RepositoryGraph } from "./types.ts";

export type { FileImport, GraphEdge, ImportResolution, ImportResolver, Neighbor, RepositoryGraph } from "./types.ts";

export interface GraphOptions {
  /** Resolves import specifiers to scanned files. */
  resolveImport?: ImportResolver;
}

const unavailable: ImportResolver = () => ({ unresolved: "import resolution not available" });

type SortKey = readonly (string | number)[];

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

const RANK: Record<ReferenceEvidence, number> = { exact: 0, heuristic: 1, unresolved: 2 };

function groupBy<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/**
 * Builds the repository graph from chunk `references` and test-to-source links. The result depends only on the
 * chunks, never on their order: chunks are sorted first and every list has a total order.
 */
export function buildGraph(chunks: readonly CodeChunk[], options: GraphOptions = {}): RepositoryGraph {
  const sorted = [...chunks].sort((a, b) => compareKeys([a.file, a.startLine, a.id], [b.file, b.startLine, b.id]));
  const order = new Map(sorted.map((chunk, i) => [chunk.id, i]));
  const byId = new Map(sorted.map((chunk) => [chunk.id, chunk]));
  const byFile = groupBy(sorted, (chunk) => chunk.file);

  const imports = importEdges({ byFile, byId }, options.resolveImport ?? unavailable);
  const edgeKey = (e: GraphEdge): SortKey => [
    order.get(e.from)!,
    e.kind,
    e.name,
    e.specifier ?? "",
    e.to ?? "",
    e.toFile ?? "",
    e.confidence,
    e.evidence,
  ];
  const edges = [...imports, ...testEdges(byFile, imports)].sort((a, b) => compareKeys(edgeKey(a), edgeKey(b)));
  const outgoingByChunk = groupBy(edges, (e) => e.from);
  const incomingByChunk = groupBy(edges, (e) => e.to);

  const testLinks = edges.filter((e) => e.kind === "test");
  const linked = (links: readonly GraphEdge[], pick: (e: GraphEdge) => string) => [...new Set(links.map(pick))].sort();

  return {
    edges,
    outgoing: (chunkId) => outgoingByChunk.get(chunkId) ?? [],
    incoming: (chunkId) => incomingByChunk.get(chunkId) ?? [],
    neighbors(chunkId) {
      const best = new Map<string, Neighbor>();
      const consider = (other: string, e: GraphEdge) => {
        if (other === chunkId || !byId.has(other) || e.confidence === "unresolved") return;
        if (best.has(other) && RANK[best.get(other)!.confidence] <= RANK[e.confidence]) return;
        best.set(other, { chunkId: other, confidence: e.confidence as NeighborConfidence, evidence: e.evidence });
      };
      for (const e of outgoingByChunk.get(chunkId) ?? []) consider(e.to!, e);
      for (const e of incomingByChunk.get(chunkId) ?? []) consider(e.from, e);
      const rank = (n: Neighbor): SortKey => {
        const chunk = byId.get(n.chunkId)!;
        return [RANK[n.confidence], chunk.file, chunk.startLine, chunk.id];
      };
      return [...best.values()].sort((a, b) => compareKeys(rank(a), rank(b)));
    },
    fileImports(file) {
      const best = new Map<string, FileImport>();
      for (const e of edges) {
        const target = e.toFile ?? (e.to ? byId.get(e.to)?.file : undefined);
        if (e.fromFile !== file || e.kind === "test" || !target || target === file) continue;
        const confidence = e.confidence as NeighborConfidence;
        if (!best.has(target) || RANK[best.get(target)!.confidence] > RANK[confidence]) {
          best.set(target, { file: target, confidence, evidence: e.evidence });
        }
      }
      return [...best.values()].sort((a, b) => compareKeys([a.file], [b.file]));
    },
    testsFor: (file) =>
      linked(
        testLinks.filter((e) => e.toFile === file),
        (e) => e.fromFile,
      ),
    sourcesFor: (testFile) =>
      linked(
        testLinks.filter((e) => e.fromFile === testFile),
        (e) => e.toFile!,
      ),
  };
}
