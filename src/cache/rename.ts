import { posix } from "node:path";
import { makeChunkId } from "../chunk-id.ts";
import { classifyFile } from "../repository/language.ts";
import type { CachedAnalysis } from "./analysis.ts";

/**
 * Whether an analysis recorded at `oldPath` may be reused for the same bytes at `newPath`. Both paths need the same
 * non-empty extension (lowercase compare) and must classify to the same language and strategy for these bytes. A file
 * with no extension is classified by name or shebang, so it never qualifies: a rename could change what it is.
 * `.ts` to `.tsx` is a different extension on purpose, because the TypeScript grammar depends on `.tsx`.
 */
export function canReuseOnRename(oldPath: string, newPath: string, head: string): boolean {
  const extension = posix.extname(posix.basename(newPath)).toLowerCase();
  if (extension.length <= 1 || extension !== posix.extname(posix.basename(oldPath)).toLowerCase()) return false;
  const before = classifyFile(oldPath, head);
  const after = classifyFile(newPath, head);
  return before.language !== undefined && before.language === after.language && before.strategy === after.strategy;
}

/**
 * Rewrites an analysis made at `oldPath` into the analysis of the same bytes at `newPath`: every `file`, reference
 * origin, id and `parentId`, and the `<path>: ` prefix of each warning. Equal to analyzing `newPath` from scratch for
 * every file type (tests/rename-equivalence.test.ts proves it over the fixtures and this repository's sources).
 */
export function retargetAnalysis(analysis: CachedAnalysis, oldPath: string, newPath: string): CachedAnalysis {
  const ids = new Map<string, string>();
  for (const chunk of analysis.chunks) ids.set(chunk.id, makeChunkId({ ...chunk, file: newPath }));
  const prefix = `${oldPath}: `;
  return {
    chunks: analysis.chunks.map((chunk) => ({
      ...chunk,
      id: ids.get(chunk.id)!,
      file: newPath,
      references: chunk.references.map((reference) => ({
        ...reference,
        from: { ...reference.from, file: newPath },
        ...(reference.targetChunkId === undefined
          ? {}
          : { targetChunkId: ids.get(reference.targetChunkId) ?? reference.targetChunkId }),
      })),
      ...(chunk.parentId === undefined ? {} : { parentId: ids.get(chunk.parentId) ?? chunk.parentId }),
    })),
    warnings: analysis.warnings.map((warning) =>
      warning.startsWith(prefix) ? `${newPath}: ${warning.slice(prefix.length)}` : warning,
    ),
    textOnly: analysis.textOnly,
  };
}
