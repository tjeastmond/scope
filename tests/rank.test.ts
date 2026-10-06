import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildGraph } from "../src/graph/graph.ts";
import { DEFAULT_RETRIEVAL_CONFIG, resolveRetrievalConfig, type RetrievalConfig } from "../src/retrieval/config.ts";
import { buildIndexes } from "../src/retrieval/indexes.ts";
import { rankCandidates, type Candidate } from "../src/retrieval/rank.ts";
import { scoreChunks, weighSignals, type ChunkScore, type Signal } from "../src/retrieval/score.ts";
import { extractTaskTerms } from "../src/retrieval/terms.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk, ReferenceEvidence } from "../src/types.ts";
import { FIXTURES, loadLabeledTasks, resolve } from "./helpers/labels.ts";

const CONFIG = DEFAULT_RETRIEVAL_CONFIG;
const ZERO: Record<Signal, number> = { symbol: 0, lexical: 0, path: 0, dependency: 0, test: 0, proximity: 0 };

/** A chunk whose id is `file#name`; `refs` maps target chunk ids to the evidence of the edge. */
function chunk(file: string, name: string, refs: Record<string, ReferenceEvidence> = {}, startLine = 1): CodeChunk {
  return {
    id: `${file}#${name}`,
    file,
    language: "typescript",
    kind: "function",
    name,
    startLine,
    endLine: startLine + 2,
    content: `export function ${name}() {}`,
    estimatedTokens: 5,
    references: Object.entries(refs).map(([target, evidence]) => ({
      kind: "call" as const,
      from: { file, line: startLine + 1 },
      name: target,
      targetChunkId: target,
      evidence,
    })),
  };
}

/** Only the best match is a seed, so the other direct matches are scored against it. */
const ONE_SEED = resolveRetrievalConfig({ expansion: { seedCount: 1 } });

/** A direct match scored only by the symbol signal. */
const direct = (c: CodeChunk, symbol = 1): ChunkScore => weighSignals(c.id, { ...ZERO, symbol }, CONFIG.weights);

function rank(chunks: CodeChunk[], seeds: ChunkScore[], config: RetrievalConfig = CONFIG): Candidate[] {
  return rankCandidates(seeds, buildGraph(chunks), buildIndexes(chunks), config);
}
const byId = (list: Candidate[]) => new Map(list.map((c) => [c.chunkId, c]));
const expandedIds = (list: Candidate[]) => list.filter((c) => c.origin !== "direct").map((c) => c.chunkId);

describe("rankCandidates on the mixed fixture", async () => {
  const { chunks } = await loadChunks(join(FIXTURES, "mixed-app"));
  const indexes = buildIndexes(chunks);
  const graph = buildGraph(chunks);
  const tasks = await loadLabeledTasks("mixed-app");
  const ranked = (task: string) => {
    const lexical = scoreChunks(extractTaskTerms(task), indexes, CONFIG.weights);
    return { lexical, candidates: rankCandidates(lexical, graph, indexes, CONFIG) };
  };
  const idOf = (label: string) => resolve(label, chunks)[0]!.id;
  /** Index of the labeled chunk, or Infinity when it is not a candidate. */
  const rankOf = (list: readonly { chunkId: string }[], label: string) => {
    const index = list.findIndex((c) => c.chunkId === idOf(label));
    return index < 0 ? Infinity : index;
  };

  test("every candidate carries all six signals and contributions, an exact total and an origin", () => {
    for (const task of tasks) {
      const { candidates } = ranked(task.task);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(Object.keys(candidate.signals).sort()).toEqual(Object.keys(ZERO).sort());
        expect(Object.keys(candidate.contributions).sort()).toEqual(Object.keys(ZERO).sort());
        for (const name of Object.keys(ZERO) as Signal[]) {
          const value = candidate.signals[name];
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(candidate.contributions[name]).toBe(CONFIG.weights[name] * value);
        }
        expect(candidate.total).toBe(Object.values(candidate.contributions).reduce((sum, v) => sum + v, 0));
        expect(candidate.origin === "direct" || candidate.origin.startsWith("expanded-from:")).toBe(true);
      }
      const totals = candidates.map((c) => c.total);
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
    }
  });

  test("due-date task: the dependency carries the dependency signal and outranks unrelated chunks", () => {
    const task = tasks.find((t) => t.id === "due-date-column")!;
    const { lexical, candidates } = ranked(task.task);
    const label = "web/src/hooks/useInvoices.ts::InvoiceDto";
    const dto = candidates.find((c) => c.chunkId === idOf(label))!;
    expect(dto.signals.dependency).toBe(1);
    expect(dto.contributions.dependency).toBe(CONFIG.weights.dependency);
    for (const unrelated of [
      "api/src/util/csv.ts::toCsv",
      "worker/format.py::format",
      "web/src/lib/validate.ts::validate",
    ]) {
      expect(rankOf(candidates, unrelated)).toBeGreaterThan(rankOf(candidates, label));
    }
    // The graph signals do not push it down relative to lexical scoring alone.
    expect(rankOf(candidates, label)).toBeLessThanOrEqual(rankOf(lexical, label));
  });

  test("chunks reached only through the graph enter as expansions with graph signals only", () => {
    const { candidates } = ranked("Fix `InvoiceService.listByStatus` ordering");
    const expanded = candidates.filter((c) => c.origin !== "direct");
    expect(expanded.length).toBeGreaterThan(0);
    for (const candidate of expanded) {
      expect(candidate.signals.symbol + candidate.signals.lexical + candidate.signals.path).toBe(0);
      expect(candidate.signals.dependency + candidate.signals.test).toBeGreaterThan(0);
    }
  });
});

describe("rankCandidates on synthetic repositories", () => {
  const source = chunk("api/service.ts", "runService", {
    "api/dep.ts#helper": "exact",
    "api/weak.ts#guess": "heuristic",
  });
  const dep = chunk("api/dep.ts", "helper");
  const weak = chunk("api/weak.ts", "guess");
  const testChunk = chunk("api/service.test.ts", "checksRunService");
  const unrelated = chunk("zzz/other.ts", "other");
  const chunks = [source, dep, weak, testChunk, unrelated];

  test("seeds are direct with dependency 0; neighbours are expanded from the seed over exact or heuristic edges", () => {
    const map = byId(rank(chunks, [direct(source)]));
    const seed = map.get(source.id)!;
    expect(seed.origin).toBe("direct");
    expect(seed.signals).toEqual({ ...ZERO, symbol: 1 });
    expect(map.get(dep.id)).toMatchObject({ origin: `expanded-from:${source.id}`, signals: { dependency: 1 } });
    expect(map.get(weak.id)).toMatchObject({ origin: `expanded-from:${source.id}`, signals: { dependency: 0.6 } });
    expect(map.get(dep.id)!.total).toBeGreaterThan(map.get(weak.id)!.total);
    expect(map.has(unrelated.id)).toBe(false);
  });

  test("a related test chunk is an expansion with the test signal and outranks an unrelated direct match", () => {
    const list = rank(chunks, [direct(source), direct(unrelated, 0.01)]);
    expect(byId(list).get(testChunk.id)).toMatchObject({ origin: `expanded-from:${source.id}`, signals: { test: 1 } });
    expect(list.findIndex((c) => c.chunkId === testChunk.id)).toBeLessThan(
      list.findIndex((c) => c.chunkId === unrelated.id),
    );
  });

  test("a test seed brings in its source file's chunks as test-related", () => {
    const map = byId(rank(chunks, [direct(testChunk)]));
    expect(map.get(source.id)).toMatchObject({ origin: `expanded-from:${testChunk.id}`, signals: { test: 1 } });
  });

  test("proximity is 1 in the best seed's directory, 0.5 in its top-level directory, 0 elsewhere", () => {
    const seed = chunk("web/src/a.ts", "seed");
    const sameDir = chunk("web/src/b.ts", "sameDir");
    const sameTop = chunk("web/lib/c.ts", "sameTop");
    const far = chunk("api/d.ts", "far");
    const scores = [direct(seed), direct(sameDir, 0.5), direct(sameTop, 0.5), direct(far, 0.5)];
    const map = byId(rank([seed, sameDir, sameTop, far], scores, ONE_SEED));
    expect(map.get(seed.id)!.signals.proximity).toBe(0);
    expect(map.get(sameDir.id)!.signals.proximity).toBe(1);
    expect(map.get(sameTop.id)!.signals.proximity).toBe(0.5);
    expect(map.get(far.id)!.signals.proximity).toBe(0);
    expect(map.get(sameTop.id)!.contributions.proximity).toBe(CONFIG.weights.proximity * 0.5);
  });

  test("a directly matched neighbour of a seed gets the dependency signal and stays direct", () => {
    const map = byId(rank(chunks, [direct(source), direct(weak, 0.5)], ONE_SEED));
    expect(map.get(weak.id)).toMatchObject({ origin: "direct", signals: { dependency: 0.6 } });
  });

  test("a chunk linked to two seeds keeps the stronger dependency signal", () => {
    // Seed a (ranked first) reaches shared over an exact edge, seed b (ranked second) over a heuristic one.
    const shared = chunk("src/shared.ts", "shared");
    const a = chunk("src/a.ts", "a", { [shared.id]: "exact" });
    const b = chunk("src/b.ts", "b", { [shared.id]: "heuristic" });
    const ranked = byId(rank([a, b, shared], [direct(a, 1), direct(b, 0.9)]));
    expect(ranked.get(shared.id)?.signals.dependency).toBe(1);
  });

  test("expansion caps include test-derived candidates", () => {
    const src = chunk("lib/thing.ts", "thing", { "lib/dep1.ts#d1": "exact", "lib/dep2.ts#d2": "exact" });
    const pair = [
      src,
      chunk("lib/dep1.ts", "d1"),
      chunk("lib/dep2.ts", "d2"),
      chunk("lib/thing.test.ts", "t2", {}, 21),
      chunk("lib/thing.test.ts", "t0", {}, 1),
      chunk("lib/thing.test.ts", "t1", {}, 11),
    ];
    const perSeed = resolveRetrievalConfig({ expansion: { maxNeighborsPerSeed: 3, maxExpanded: 10 } });
    // Dependencies first, then test chunks in start-line order until the per-seed cap.
    expect(expandedIds(rank(pair, [direct(src)], perSeed))).toEqual([
      "lib/dep1.ts#d1",
      "lib/dep2.ts#d2",
      "lib/thing.test.ts#t0",
    ]);
    const global = resolveRetrievalConfig({ expansion: { maxNeighborsPerSeed: 5, maxExpanded: 4 } });
    expect(expandedIds(rank(pair, [direct(src)], global))).toHaveLength(4);
    const none = resolveRetrievalConfig({ expansion: { seedCount: 1, maxNeighborsPerSeed: 1, maxExpanded: 1 } });
    expect(expandedIds(rank(pair, [direct(src)], none))).toEqual(["lib/dep1.ts#d1"]);
  });

  test("output order is deterministic and independent of input order", () => {
    const seeds = [direct(source), direct(unrelated, 0.2)];
    expect(rank([...chunks].reverse(), seeds)).toEqual(rank(chunks, seeds));
  });
});
