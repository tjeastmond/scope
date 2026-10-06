import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateCandidates, dedupeCandidates } from "../src/retrieval/generate.ts";
import { buildIndexes } from "../src/retrieval/indexes.ts";
import type { Candidate } from "../src/retrieval/rank.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";
import { FIXTURES, loadLabeledTasks } from "./helpers/labels.ts";

function chunk(file: string, name: string, startLine: number, endLine: number, kind: CodeChunk["kind"] = "function") {
  return {
    id: `${file}:${startLine}-${endLine}:${kind}:${name}`,
    file,
    language: "typescript",
    kind,
    name,
    startLine,
    endLine,
    content: `export function ${name}() {}`,
    references: [],
  } satisfies CodeChunk;
}

const candidate = (id: string, total: number): Candidate => ({
  chunkId: id,
  signals: { symbol: total, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 },
  contributions: { symbol: total, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 },
  total,
  origin: "direct",
});

describe("dedupeCandidates", () => {
  const a = chunk("src/a.ts", "a", 1, 5);
  const alias = chunk("src/a.ts", "aAlias", 1, 5, "type");
  const header = chunk("src/a.ts", "Box", 10, 14, "class");
  const member = chunk("src/a.ts", "Box.size", 15, 18, "method");
  const sameRangeElsewhere = chunk("src/b.ts", "b", 1, 5);
  const indexes = buildIndexes([a, alias, header, member, sameRangeElsewhere]);
  const ids = (list: Candidate[]) => list.map((c) => c.chunkId);

  test("keeps the first of two chunks with the identical range in a file", () => {
    const out = dedupeCandidates([candidate(a.id, 1), candidate(alias.id, 0.5)], indexes);
    expect(ids(out)).toEqual([a.id]);
    expect(ids(dedupeCandidates([candidate(alias.id, 1), candidate(a.id, 0.5)], indexes))).toEqual([alias.id]);
  });

  test("drops a repeated chunk id", () => {
    expect(ids(dedupeCandidates([candidate(a.id, 1), candidate(a.id, 0.5)], indexes))).toEqual([a.id]);
  });

  test("keeps a container header and its member, and the same range in another file", () => {
    const list = [
      candidate(header.id, 1),
      candidate(member.id, 0.9),
      candidate(a.id, 0.8),
      candidate(sameRangeElsewhere.id, 0.7),
    ];
    expect(ids(dedupeCandidates(list, indexes))).toEqual(ids(list));
  });
});

describe("generateCandidates is deterministic", async () => {
  const { chunks } = await loadChunks(join(FIXTURES, "mixed-app"));
  const tasks = await loadLabeledTasks("mixed-app");
  const shuffled = (list: CodeChunk[], seed: number) => {
    const out = [...list];
    let state = seed;
    for (let i = out.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      const j = state % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  test("20 runs and shuffled scan orders give byte-identical results", () => {
    for (const { task } of tasks) {
      const expected = JSON.stringify(generateCandidates(task, chunks));
      expect(expected.length).toBeGreaterThan(2);
      for (let run = 0; run < 20; run++) {
        expect(JSON.stringify(generateCandidates(task, run % 2 ? chunks : shuffled(chunks, run)))).toBe(expected);
      }
      expect(JSON.stringify(generateCandidates(task, [...chunks].reverse()))).toBe(expected);
    }
  });

  test("candidates are ordered by total, then path, start line and id, with no duplicates", () => {
    for (const { task } of tasks) {
      const out = generateCandidates(task, chunks);
      const byId = new Map(chunks.map((c) => [c.id, c]));
      expect(new Set(out.map((c) => c.chunkId)).size).toBe(out.length);
      for (let i = 1; i < out.length; i++) {
        const [p, q] = [out[i - 1]!, out[i]!];
        expect(p.total).toBeGreaterThanOrEqual(q.total);
        if (p.total === q.total) {
          const [x, y] = [byId.get(p.chunkId)!, byId.get(q.chunkId)!];
          const key = (c: CodeChunk) => [c.file, String(c.startLine).padStart(9, "0"), c.id].join("\0");
          expect(key(x) < key(y)).toBe(true);
        }
      }
    }
  });
});
