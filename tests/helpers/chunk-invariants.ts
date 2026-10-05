import { expect } from "bun:test";
import type { CodeChunk } from "../../src/types.ts";

/**
 * The container policy (docs/chunk-model.md): chunk ids are unique; `parentId` and `containerName` come together and
 * name another chunk of the same file; and no two chunks of a file overlap unless one is an ancestor of the other
 * through `parentId` links.
 */
export function expectContainerInvariants(chunks: readonly CodeChunk[]): void {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  expect(byId.size).toBe(chunks.length);
  for (const chunk of chunks) {
    expect(chunk.parentId === undefined).toBe(chunk.containerName === undefined);
    if (chunk.parentId === undefined) continue;
    const parent = byId.get(chunk.parentId);
    expect(parent).toBeDefined();
    expect(parent?.file).toBe(chunk.file);
    expect(parent?.name).toBe(chunk.containerName as string);
    expect(chunk.parentId).not.toBe(chunk.id);
  }
  const ancestors = (chunk: CodeChunk): Set<string> => {
    const seen = new Set<string>();
    for (let up = chunk.parentId; up !== undefined && !seen.has(up); up = byId.get(up)?.parentId) seen.add(up);
    return seen;
  };
  for (const [index, a] of chunks.entries()) {
    for (const b of chunks.slice(index + 1)) {
      if (a.file !== b.file || a.endLine < b.startLine || b.endLine < a.startLine) continue;
      expect(ancestors(a).has(b.id) || ancestors(b).has(a.id)).toBe(true);
    }
  }
}
