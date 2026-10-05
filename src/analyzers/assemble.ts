import { makeChunkId } from "../chunk-id.ts";
import type { AnalysisResult, ChunkKind, CodeChunk, Language, TokenEstimator } from "../types.ts";

/** A container (class, namespace) of at most this many lines stays one chunk and its members are not chunks. */
export const SMALL_CONTAINER_LINES = 5;

/** A region an extractor found, as a 1-based inclusive line range. */
export interface Region {
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  name?: string | undefined;
  /** The container this region is a member of. It must be another region of the same call, listed before this one. */
  parent?: Region | undefined;
}

/**
 * Applies the container policy (docs/chunk-model.md, "Containers"). A region that is some other region's `parent` is
 * a container: when it is small, or its members share lines with it or with each other, it stays whole and its
 * members (all descendants) are dropped; otherwise its range shrinks to the header, from its first line to the last
 * non-blank line before its first member, and the members keep their own ranges. The result never overlaps within a
 * file, so a parent link is the only relation between a header and its members.
 */
function applyContainerPolicy(
  regions: readonly Region[],
  lines: readonly string[],
): { region: Region; endLine: number }[] {
  const children = new Map<Region, Region[]>();
  for (const region of regions) {
    if (region.parent) children.set(region.parent, [...(children.get(region.parent) ?? []), region]);
  }
  const dropped = new Set<Region>();
  const headerEnds = new Map<Region, number>();
  for (const region of regions) {
    const members = children.get(region);
    if (!members || dropped.has(region)) continue;
    const ordered = [...members].sort((a, b) => a.startLine - b.startLine);
    const first = ordered[0];
    if (!first) continue;
    let end = first.startLine - 1;
    while (end > region.startLine && (lines[end - 1] ?? "").trim() === "") end--;
    const separate =
      region.endLine - region.startLine + 1 > SMALL_CONTAINER_LINES &&
      end >= region.startLine &&
      first.startLine > region.startLine &&
      ordered.every((member, index) => index === 0 || member.startLine > (ordered[index - 1] as Region).endLine);
    if (separate) {
      headerEnds.set(region, end);
      continue;
    }
    const stack = [...members];
    for (let next = stack.pop(); next; next = stack.pop()) {
      dropped.add(next);
      stack.push(...(children.get(next) ?? []));
    }
  }
  return regions
    .filter((region) => !dropped.has(region))
    .map((region) => ({ region, endLine: headerEnds.get(region) ?? region.endLine }));
}

/**
 * Turns regions into chunks: `content` is the exact source lines of each range (split on `\n` only), identical
 * regions (for example two `<nav></nav>` on one line) collapse to one so chunk ids stay unique, and `broken` adds the
 * syntax-error warning, which counts the extracted `unit`s. Regions with a `parent` follow the container policy and
 * their chunks carry `parentId` and `containerName`.
 */
export function assembleChunks(
  file: string,
  source: string,
  language: Language,
  regions: readonly Region[],
  broken: boolean,
  estimator: TokenEstimator,
  unit = "chunks",
): AnalysisResult {
  const lines = source.split("\n");
  const ids = new Map<Region, string>();
  const chunks = applyContainerPolicy(regions, lines).map(({ region, endLine }): CodeChunk => {
    const { startLine, kind, name } = region;
    const content = lines.slice(startLine - 1, endLine).join("\n");
    const id = makeChunkId({ file, startLine, endLine, kind, name });
    ids.set(region, id);
    const parentId = region.parent ? ids.get(region.parent) : undefined;
    return {
      id,
      file,
      language,
      kind,
      ...(name === undefined ? {} : { name }),
      startLine,
      endLine,
      content,
      references: [],
      estimatedTokens: estimator.count(content),
      ...(parentId === undefined || region.parent === undefined
        ? {}
        : { parentId, ...(region.parent.name === undefined ? {} : { containerName: region.parent.name }) }),
    };
  });
  const unique = [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
  const warnings = broken
    ? [`${file}: syntax errors; extracted ${unique.length} ${unit} from the parseable regions`]
    : [];
  return { chunks: unique, warnings, ...(broken ? { partial: true } : {}) };
}

/** Collapses runs of whitespace to single spaces, for names taken from source text. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
