import type { CodeChunk, Reference } from "../types.ts";
import type { GraphEdge, ImportResolver } from "./types.ts";

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const DOTS_ONLY = /^\.+$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, textual: shadowing and comments are not considered. */
function mentions(content: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, "u").test(content);
}

/** A name that can be looked up in code: not `default`, `*`, a side-effect import's specifier or dynamic source text. */
function usableName(ref: Reference): boolean {
  return IDENTIFIER.test(ref.name) && ref.name !== "default" && ref.name !== ref.specifier;
}

/**
 * Whether `chunk` owns `ref`. A reference inside the chunk's own range is its own. A file-level import is attached to
 * every chunk of the file, so it belongs to the chunks that mention the imported name; one without a usable name, or
 * that no chunk mentions (an unused import), is anchored on the first chunk of the file (see `importEdges`).
 */
function owns(chunk: CodeChunk, first: CodeChunk, ref: Reference): boolean {
  if (ref.from.line >= chunk.startLine && ref.from.line <= chunk.endLine) return true;
  return usableName(ref) ? mentions(chunk.content, ref.name) : chunk === first;
}

const refKey = (ref: Reference) => `${ref.kind}|${ref.from.line}|${ref.name}|${ref.specifier ?? ""}`;

export interface ImportIndex {
  /** Chunks of each file, sorted by start line. */
  byFile: ReadonlyMap<string, readonly CodeChunk[]>;
  byId: ReadonlyMap<string, CodeChunk>;
}

function edgeFor(chunk: CodeChunk, ref: Reference, index: ImportIndex, resolve: ImportResolver): GraphEdge {
  const base = {
    kind: ref.kind,
    from: chunk.id,
    fromFile: chunk.file,
    name: ref.name,
    ...(ref.specifier === undefined ? {} : { specifier: ref.specifier }),
  };
  if (ref.targetChunkId) {
    const toFile = index.byId.get(ref.targetChunkId)?.file;
    const evidence = "target chunk set by the analyzer";
    const confidence = ref.evidence ?? "heuristic";
    return { ...base, to: ref.targetChunkId, ...(toFile ? { toFile } : {}), confidence, evidence };
  }
  const { specifier } = ref;
  if (specifier === undefined) {
    return { ...base, confidence: "unresolved", evidence: ref.kind === "import" ? "dynamic specifier" : "no target" };
  }
  const from = { file: chunk.file, language: chunk.language };
  // `from . import x` may name a sibling module: `.x` is tried first, then the package itself.
  const asModule =
    chunk.language === "python" && DOTS_ONLY.test(specifier) && IDENTIFIER.test(ref.name)
      ? resolve(from, specifier + ref.name)
      : undefined;
  const resolution = asModule && "file" in asModule ? asModule : resolve(from, specifier);
  if ("unresolved" in resolution) return { ...base, confidence: "unresolved", evidence: resolution.unresolved };

  const { file, via } = resolution;
  const resolved = `import "${specifier}" resolved to ${file}${via ? ` (${via})` : ""}`;
  const symbol = resolution === asModule ? undefined : usableName(ref) ? ref.name : undefined;
  const target = symbol ? index.byFile.get(file)?.find((candidate) => candidate.name === symbol) : undefined;
  if (target) {
    const evidence = `${resolved}; ${ref.name} is a chunk there`;
    return { ...base, to: target.id, toFile: file, confidence: "exact", evidence };
  }
  const why = symbol ? `no chunk named ${ref.name} there` : "a whole-module import";
  return { ...base, toFile: file, confidence: "heuristic", evidence: `${resolved}; ${why}` };
}

/** One edge per reference a chunk owns. Nothing is dropped: unresolvable references become dangling edges. */
export function importEdges(index: ImportIndex, resolve: ImportResolver): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const chunks of index.byFile.values()) {
    const first = chunks[0]!;
    const claimed = new Set(chunks.flatMap((c) => c.references.filter((r) => owns(c, first, r)).map(refKey)));
    for (const chunk of chunks) {
      for (const ref of chunk.references) {
        if (owns(chunk, first, ref) || (chunk === first && !claimed.has(refKey(ref)))) {
          edges.push(edgeFor(chunk, ref, index, resolve));
        }
      }
    }
  }
  return edges;
}
