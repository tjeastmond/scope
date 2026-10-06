import type { ChunkKind, CodeChunk, Reference } from "../types.ts";

/** Reference kinds whose exact targets are needed to read a chunk. Calls and imports are deliberately left out. */
const SUPPORT_REFERENCE_KINDS: ReadonlySet<Reference["kind"]> = new Set(["type", "extends", "implements"]);

/** Declaration kinds worth pulling in as supports. */
const SUPPORT_TARGET_KINDS: ReadonlySet<ChunkKind> = new Set(["type", "interface", "class"]);

const byLocation = (a: CodeChunk, b: CodeChunk): number =>
  a.file.localeCompare(b.file) || a.startLine - b.startLine || a.id.localeCompare(b.id);

/**
 * Chunks needed to understand `chunk`, in a deterministic order: first its container header chain (nearest header to
 * outermost), then the exact `type`/`extends`/`implements` targets that are type, interface or class declarations, sorted
 * by location. Only one level of reference targets is followed. Ids missing from `lookup` are skipped, and the chunk
 * itself is never returned.
 */
export function requiredSupports(chunk: CodeChunk, lookup: ReadonlyMap<string, CodeChunk>): CodeChunk[] {
  const supports: CodeChunk[] = [];
  const seen = new Set<string>([chunk.id]);

  for (let parentId = chunk.parentId; parentId !== undefined && !seen.has(parentId);) {
    const header = lookup.get(parentId);
    if (!header) break;
    seen.add(header.id);
    supports.push(header);
    parentId = header.parentId;
  }

  const targets: CodeChunk[] = [];
  for (const reference of chunk.references) {
    if (reference.evidence !== "exact" || !reference.targetChunkId) continue;
    if (!SUPPORT_REFERENCE_KINDS.has(reference.kind) || seen.has(reference.targetChunkId)) continue;
    const target = lookup.get(reference.targetChunkId);
    if (!target || !SUPPORT_TARGET_KINDS.has(target.kind)) continue;
    seen.add(target.id);
    targets.push(target);
  }
  return [...supports, ...targets.sort(byLocation)];
}
