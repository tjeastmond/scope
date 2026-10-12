import { createHash } from "node:crypto";
import type { ChunkKind } from "./types.ts";

/** Stable chunk identity from file and range plus kind and name, so same-named symbols never collide. */
export function makeChunkId(chunk: {
  file: string;
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  name?: string;
}): string {
  const key = `${chunk.file}:${chunk.startLine}-${chunk.endLine}:${chunk.kind}:${chunk.name ?? ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
