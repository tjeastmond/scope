import { posix } from "node:path";
import type { CodeChunk } from "../types.ts";
import type { GraphEdge } from "./types.ts";

const TEST_BASENAME = /\.(test|spec)\.[^.]+$|^test_.+\.py$|_test\.py$/;
const TEST_DIRECTORIES = new Set(["tests", "__tests__", "test"]);

export function isTestFile(path: string): boolean {
  const segments = path.split("/");
  return TEST_BASENAME.test(segments.at(-1)!) || segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
}

function stem(path: string): string {
  return posix.basename(path, posix.extname(path));
}

/** `format.test.ts`, `format.spec.js`, `test_format.py` and `format_test.py` all test `format`. */
function testedStem(path: string): string {
  return stem(path)
    .replace(/\.(test|spec)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "");
}

function family(chunk: CodeChunk): string {
  return chunk.language === "typescript" || chunk.language === "javascript" ? "ecmascript" : chunk.language;
}

function sharedDirectories(a: string, b: string): number {
  const [left, right] = [a.split("/").slice(0, -1), b.split("/").slice(0, -1)];
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}

/**
 * `kind: "test"` edges, anchored on the first chunk of the test file and pointing at a source file (`toFile`):
 * - exact: the test file imports a non-test file (taken from the import edges);
 * - heuristic: naming convention, only when the test imports none of the same-stem files. Among several same-stem
 *   files of the same language family, the ones sharing the longest directory prefix with the test win, and a tie is
 *   kept whole with the ambiguity stated.
 */
export function testEdges(
  byFile: ReadonlyMap<string, readonly CodeChunk[]>,
  imports: readonly GraphEdge[],
): GraphEdge[] {
  const sources = [...byFile.keys()].filter((file) => !isTestFile(file));
  const edges: GraphEdge[] = [];
  for (const [testFile, chunks] of byFile) {
    if (!isTestFile(testFile)) continue;
    const anchor = chunks[0]!;
    const make = (toFile: string, confidence: GraphEdge["confidence"], evidence: string): GraphEdge => ({
      kind: "test",
      from: anchor.id,
      fromFile: testFile,
      toFile,
      name: toFile,
      confidence,
      evidence,
    });
    const imported = new Set(
      imports.filter((e) => e.fromFile === testFile && e.toFile && !isTestFile(e.toFile)).map((e) => e.toFile!),
    );
    for (const file of imported) edges.push(make(file, "exact", `test file ${testFile} imports ${file}`));

    const named = sources.filter(
      (file) => stem(file) === testedStem(testFile) && family(byFile.get(file)![0]!) === family(anchor),
    );
    if (named.length === 0 || named.some((file) => imported.has(file))) continue;
    const closest = Math.max(...named.map((file) => sharedDirectories(testFile, file)));
    const best = named.filter((file) => sharedDirectories(testFile, file) === closest);
    const note = best.length > 1 ? `; ambiguous, ${best.length} files share the name` : "";
    for (const file of best) {
      edges.push(make(file, "heuristic", `test file naming convention: ${testFile} <-> ${file}${note}`));
    }
  }
  return edges;
}
