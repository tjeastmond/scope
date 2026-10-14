import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRetrievalConfig } from "../src/retrieval/config.ts";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

const chunk = (file: string, startLine: number, id: string, name = id, content = "const x = 1;"): CodeChunk => ({
  id,
  file,
  language: "typescript",
  kind: "function",
  name,
  startLine,
  endLine: startLine + 1,
  content,
  references: [],
});

const REPO = [
  chunk("a/render.ts", 1, "ra", "renderA"),
  chunk("b/render.ts", 1, "rb", "renderB"),
  chunk("c/alpha.ts", 1, "alpha", "alpha"),
  chunk("d/beta.ts", 5, "beta2", "second"),
  chunk("d/beta.ts", 1, "beta1", "first"),
  chunk("e/gamma.ts", 1, "gamma", "gamma"),
  chunk("f/delta.ts", 1, "delta", "delta"),
  chunk("tests/zeta.test.ts", 1, "zeta", "zeta"),
];
const TASK = "fix render";
const prior = (entries: Record<string, number>, config = {}) => ({ scores: new Map(Object.entries(entries)), config });

test("with no prior, output is identical to an empty prior and carries no contribution", async () => {
  const bare = selectCandidates(TASK, REPO);
  expect(bare.pathPrior).toBeUndefined();
  expect("pathPrior" in bare).toBe(false);
  const empty = selectCandidates(TASK, REPO, undefined, prior({}));
  expect(JSON.stringify(empty.candidates)).toBe(JSON.stringify(bare.candidates));
  expect(JSON.stringify([...empty.ranking])).toBe(JSON.stringify([...bare.ranking]));
  expect(empty.pathPrior).toEqual({ boosted: 0, added: [] });

  // The same on a real fixture, where the shortlist cap applies.
  const { chunks } = await loadChunks(join(import.meta.dir, "../fixtures/mixed-app"));
  const task = "Show each invoice due date in the invoice list and make the reminder retry attempts configurable";
  const real = selectCandidates(task, chunks);
  const realEmpty = selectCandidates(task, chunks, undefined, prior({}));
  expect(JSON.stringify(realEmpty.candidates)).toBe(JSON.stringify(real.candidates));
  expect(JSON.stringify([...realEmpty.ranking])).toBe(JSON.stringify([...real.ranking]));
});

test("a prior boosts existing candidates by weight times prior and can reorder them", () => {
  const before = selectCandidates(TASK, REPO);
  expect(before.ranking.get("ra")!.total).toBe(before.ranking.get("rb")!.total);
  expect(before.candidates[0]!.id).toBe("ra");
  const after = selectCandidates(TASK, REPO, undefined, prior({ "b/render.ts": 1, "a/render.ts": 0.25 }));
  expect(after.candidates[0]!.id).toBe("rb");
  expect(after.ranking.get("rb")!.total).toBeCloseTo(before.ranking.get("rb")!.total + 0.2);
  expect(after.ranking.get("ra")!.total).toBeCloseTo(before.ranking.get("ra")!.total + 0.05);
  expect(after.ranking.get("rb")!.origin).toBe("direct");
  expect(after.pathPrior!.boosted).toBe(2);
  expect(
    selectCandidates(TASK, REPO, undefined, prior({ "b/render.ts": 1 }, { weight: 0.5 })).ranking.get("rb")!.total,
  ).toBeCloseTo(before.ranking.get("rb")!.total + 0.5);
});

test("adds up to maxAdded chunks of files without a candidate, best prior first, with origin path-prior", () => {
  const scores = { "c/alpha.ts": 0.9, "d/beta.ts": 0.8, "e/gamma.ts": 0.7, "f/delta.ts": 0.4 };
  const picked = selectCandidates("fix render", REPO, undefined, prior(scores, { maxAdded: 2 }));
  expect(picked.pathPrior!.added).toEqual(["c/alpha.ts", "d/beta.ts"]);
  expect(picked.ranking.get("alpha")).toMatchObject({ origin: "path-prior", total: expect.closeTo(0.18) });
  // The earliest named chunk stands for the file.
  expect(picked.ranking.has("beta1")).toBe(true);
  expect(picked.ranking.has("beta2")).toBe(false);
  expect(picked.ranking.has("gamma")).toBe(false);
  // Below minFilePrior nothing is added.
  expect(picked.ranking.has("delta")).toBe(false);
  const all = selectCandidates("fix render", REPO, undefined, prior(scores));
  expect(all.pathPrior!.added).toEqual(["c/alpha.ts", "d/beta.ts", "e/gamma.ts"]);
  expect(
    selectCandidates("fix render", REPO, undefined, prior(scores, { minFilePrior: 0.3 })).pathPrior!.added,
  ).toContain("f/delta.ts");
});

test("never adds a test file, however high its prior", () => {
  const picked = selectCandidates("fix render", REPO, undefined, prior({ "tests/zeta.test.ts": 1, "c/alpha.ts": 0.6 }));
  expect(picked.pathPrior!.added).toEqual(["c/alpha.ts"]);
  expect(picked.ranking.has("zeta")).toBe(false);
});

test("a boosted or added candidate can enter a capped shortlist", () => {
  const many = Array.from({ length: 30 }, (_, i) => chunk(`noise/n${i}.ts`, 1, `n${i}`, `n${i}`));
  const cap = { shortlistSize: 3, expansion: { seedCount: 2, maxExpanded: 2 } };
  const small = resolveRetrievalConfig(cap);
  const without = selectCandidates("fix render", [...REPO, ...many], small);
  const withPrior = selectCandidates("fix render", [...REPO, ...many], small, prior({ "c/alpha.ts": 1 }));
  expect(without.candidates.map((c) => c.id)).not.toContain("alpha");
  expect(withPrior.candidates.map((c) => c.id)).toContain("alpha");
  expect(withPrior.pathPrior!.added).toEqual(["c/alpha.ts"]);
});
