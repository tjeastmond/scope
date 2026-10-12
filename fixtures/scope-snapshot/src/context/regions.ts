import type { Language, ScopeRegion, SelectedChunk } from "../types.ts";

/** One emitted block of source: the union of adjacent, overlapping or nested selected chunks of a file. */
export interface Region {
  file: string;
  language: Language;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Source lines `startLine..endLine` joined with "\n"; never trimmed or normalized. */
  content: string;
  /** The selected chunks the region was built from (provenance), sorted by start line then id. */
  chunks: SelectedChunk[];
}

const byRange = (a: SelectedChunk, b: SelectedChunk): number =>
  a.chunk.startLine - b.chunk.startLine || a.chunk.endLine - b.chunk.endLine || a.chunk.id.localeCompare(b.chunk.id);

function buildRegion(members: SelectedChunk[]): Region {
  const first = members[0]!;
  let endLine = first.chunk.endLine;
  for (const member of members) endLine = Math.max(endLine, member.chunk.endLine);
  const startLine = first.chunk.startLine;

  // Each absolute line comes from the first chunk, in sorted order, that covers it.
  const lines = new Array<string>(endLine - startLine + 1).fill("");
  const filled = new Array<boolean>(lines.length).fill(false);
  for (const { chunk } of members) {
    const own = chunk.content.split("\n");
    for (let i = 0; i < own.length; i++) {
      const slot = chunk.startLine + i - startLine;
      if (slot < 0 || slot >= lines.length || filled[slot]) continue;
      filled[slot] = true;
      lines[slot] = own[i]!;
    }
  }
  return {
    file: first.chunk.file,
    language: first.chunk.language,
    startLine,
    endLine,
    content: lines.join("\n"),
    chunks: members,
  };
}

/**
 * Merges selected chunks of the same file that overlap, nest or touch (`next.start <= current.end + 1`) into regions,
 * so no line is charged or printed twice. A gap of one or more lines keeps chunks apart. Regions are sorted by file,
 * then start line. Pure and deterministic.
 */
export function mergeRegions(selected: readonly SelectedChunk[]): Region[] {
  const byFile = new Map<string, SelectedChunk[]>();
  for (const item of selected) {
    const list = byFile.get(item.chunk.file);
    if (list) list.push(item);
    else byFile.set(item.chunk.file, [item]);
  }

  const regions: Region[] = [];
  for (const file of [...byFile.keys()].sort((a, b) => a.localeCompare(b))) {
    const sorted = [...byFile.get(file)!].sort(byRange);
    let group: SelectedChunk[] = [];
    let groupEnd = 0;
    for (const item of sorted) {
      if (group.length > 0 && item.chunk.startLine > groupEnd + 1) {
        regions.push(buildRegion(group));
        group = [];
      }
      groupEnd = group.length === 0 ? item.chunk.endLine : Math.max(groupEnd, item.chunk.endLine);
      group.push(item);
    }
    if (group.length > 0) regions.push(buildRegion(group));
  }
  return regions;
}

/** Serializable form of a region: provenance as chunk ids. */
export const toScopeRegion = (region: Region): ScopeRegion => ({
  file: region.file,
  language: region.language,
  startLine: region.startLine,
  endLine: region.endLine,
  content: region.content,
  chunkIds: region.chunks.map((item) => item.chunk.id),
});
