import { describe, expect, test } from "bun:test";
import { buildGraph } from "../src/graph/graph.ts";
import type { RepositoryGraph } from "../src/graph/types.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/retrieval/config.ts";
import { expandNeighbors } from "../src/retrieval/expand.ts";
import type { ChunkScore } from "../src/retrieval/score.ts";
import type { CodeChunk, ReferenceEvidence } from "../src/types.ts";

const CONFIG = { seedCount: 5, maxNeighborsPerSeed: 4, maxExpanded: 10 };

/** A chunk per name, in its own file; `refs` are edges to other names with their confidence. */
function node(name: string, refs: Record<string, ReferenceEvidence> = {}): CodeChunk {
  return {
    id: `id-${name}`,
    file: `src/${name}.ts`,
    language: "typescript",
    kind: "function",
    name,
    startLine: 1,
    endLine: 3,
    content: `export function ${name}() {}`,
    references: Object.entries(refs).map(([target, evidence]) => ({
      kind: "call" as const,
      from: { file: `src/${name}.ts`, line: 2 },
      name: target,
      targetChunkId: `id-${target}`,
      evidence,
    })),
  };
}

const score = (name: string, total = 1): ChunkScore => ({
  chunkId: `id-${name}`,
  signals: { symbol: total, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 },
  contributions: { symbol: total, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 },
  total,
});

const build = (chunks: CodeChunk[]): RepositoryGraph => buildGraph(chunks);
const ids = (names: string[]) => names.map((name) => `id-${name}`);
const chosen = (result: { chunkId: string }[]) => result.map((e) => e.chunkId);

describe("expandNeighbors", () => {
  test("terminates on cycles, adds each chunk once and never re-adds a seed", () => {
    const graph = build([
      node("A", { B: "exact" }),
      node("B", { A: "exact" }),
      node("X", { Y: "exact" }),
      node("Y", { Z: "exact" }),
      node("Z", { X: "exact" }),
    ]);
    const result = expandNeighbors([score("A"), score("X")], graph, CONFIG);
    expect(chosen(result)).toEqual(ids(["B", "Y", "Z"]));
    expect(new Set(chosen(result)).size).toBe(result.length);
    expect(result.map((e) => e.seedId)).toEqual(ids(["A", "X", "X"]));
    // Expanded chunks are not expanded in turn: nothing beyond one hop.
    const chain = build([node("A", { B: "exact" }), node("B", { C: "exact" }), node("C")]);
    expect(chosen(expandNeighbors([score("A")], chain, CONFIG))).toEqual(ids(["B"]));
  });

  test("a 1,000-neighbour hub stays within the caps and yields the deterministic first ones", () => {
    const leaves = Array.from({ length: 1000 }, (_, i) => `leaf${String(i).padStart(4, "0")}`);
    const graph = build([
      node("hub", Object.fromEntries(leaves.map((l) => [l, "exact" as const]))),
      ...leaves.map((l) => node(l)),
    ]);
    const result = expandNeighbors([score("hub")], graph, CONFIG);
    expect(chosen(result)).toEqual(ids(leaves.slice(0, 4)));
    const wide = expandNeighbors([score("hub")], graph, { ...CONFIG, maxNeighborsPerSeed: 50, maxExpanded: 7 });
    expect(chosen(wide)).toEqual(ids(leaves.slice(0, 7)));
    expect(chosen(expandNeighbors([score("hub")], graph, DEFAULT_RETRIEVAL_CONFIG.expansion))).toHaveLength(4);
  });

  test("exact edges beat heuristic ones when capped", () => {
    const graph = build([
      node("S", { a1: "heuristic", a2: "heuristic", b1: "exact", b2: "exact" }),
      node("a1"),
      node("a2"),
      node("b1"),
      node("b2"),
    ]);
    const result = expandNeighbors([score("S")], graph, { ...CONFIG, maxNeighborsPerSeed: 3 });
    expect(result.map((e) => [e.chunkId, e.confidence])).toEqual([
      ["id-b1", "exact"],
      ["id-b2", "exact"],
      ["id-a1", "heuristic"],
    ]);
  });

  test("a neighbour reachable from two seeds is attributed once to the higher-ranked seed", () => {
    const graph = build([
      node("S1", { shared: "exact" }),
      node("S2", { shared: "exact", own: "exact" }),
      node("shared"),
      node("own"),
    ]);
    const result = expandNeighbors([score("S2", 0.9), score("S1", 0.5)], graph, CONFIG);
    expect(result.map((e) => [e.chunkId, e.seedId, e.origin])).toEqual([
      ["id-own", "id-S2", "expanded-from:id-S2"],
      ["id-shared", "id-S2", "expanded-from:id-S2"],
    ]);
    expect(result.filter((e) => e.chunkId === "id-shared")).toHaveLength(1);
  });

  test("neighbours already scored, or seeds, are not re-added", () => {
    const graph = build([
      node("S", { seen: "exact", weak: "exact", fresh: "exact" }),
      node("seen"),
      node("weak"),
      node("fresh"),
    ]);
    const result = expandNeighbors([score("S"), score("seen", 0.5), score("weak", 0)], graph, CONFIG);
    expect(chosen(result)).toEqual(ids(["fresh"]));
  });

  test("maxExpanded caps the total across seeds", () => {
    const graph = build([
      node("S1", { a: "exact", b: "exact" }),
      node("S2", { c: "exact", d: "exact" }),
      ...["a", "b", "c", "d"].map((n) => node(n)),
    ]);
    const result = expandNeighbors([score("S1"), score("S2")], graph, { ...CONFIG, maxExpanded: 3 });
    expect(chosen(result)).toEqual(ids(["a", "b", "c"]));
  });

  test("seedCount limits how many top chunks are expanded", () => {
    const graph = build([node("S1", { a: "exact" }), node("S2", { b: "exact" }), node("a"), node("b")]);
    expect(chosen(expandNeighbors([score("S1"), score("S2")], graph, { ...CONFIG, seedCount: 1 }))).toEqual(ids(["a"]));
  });

  test("output is identical across repeated calls and shuffled graph input", () => {
    const chunks = [
      node("S1", { a: "heuristic", b: "exact", c: "exact" }),
      node("S2", { b: "exact", d: "heuristic" }),
      ...["a", "b", "c", "d"].map((n) => node(n)),
    ];
    const scores = [score("S1"), score("S2", 0.5)];
    const expected = expandNeighbors(scores, build(chunks), CONFIG);
    expect(expandNeighbors(scores, build(chunks), CONFIG)).toEqual(expected);
    expect(expandNeighbors(scores, build([...chunks].reverse()), CONFIG)).toEqual(expected);
    const shuffled = [chunks[3]!, chunks[0]!, chunks[5]!, chunks[2]!, chunks[4]!, chunks[1]!];
    expect(expandNeighbors(scores, build(shuffled), CONFIG)).toEqual(expected);
  });

  test("a seed with total 0 is not expanded", () => {
    const graph = build([node("S", { a: "exact" }), node("a")]);
    expect(expandNeighbors([score("S", 0)], graph, CONFIG)).toEqual([]);
    expect(expandNeighbors([], graph, CONFIG)).toEqual([]);
  });

  test("stops visiting neighbours once the caps are reached", () => {
    const seed = node("seed");
    const graph = build([seed]);
    let visited = 0;
    const many = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 10_000; i++) {
          visited++;
          yield { chunkId: `id-n${i}`, confidence: "exact" as const, evidence: "e" };
        }
      },
    };
    const hub: RepositoryGraph = { ...graph, neighbors: () => many as never };
    const out = expandNeighbors([score("seed")], hub, CONFIG);
    expect(out).toHaveLength(CONFIG.maxNeighborsPerSeed);
    expect(visited).toBeLessThanOrEqual(CONFIG.maxNeighborsPerSeed + 1);
  });
});
