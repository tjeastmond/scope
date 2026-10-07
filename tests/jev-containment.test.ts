import { expect, test } from "bun:test";
import { join } from "node:path";
import { requiredSupports } from "../src/context/coherence.ts";
import { JevResponseError } from "../src/jev/errors.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

// Jev judges the shortlist; it cannot widen the selection. Whatever it answers, the artifact holds only judged
// candidates plus the supporting declarations Scope itself pulls in. (There is no size budget to bypass.)
const ROOT = join(import.meta.dir, "../fixtures/mixed-app");
const TASK =
  "Show each invoice due date in the invoice list, query it in SQL, and make the reminder worker retry attempts configurable from config/app.toml, then document it.";

/** Wraps a provider and records the candidates it was asked to judge. */
function recording(inner: DecisionProvider) {
  const judged: CodeChunk[] = [];
  const provider: DecisionProvider = {
    decide: (request) => {
      judged.push(...request.candidates);
      return inner.decide(request);
    },
  };
  return { provider, judged };
}

test("an all-1.0 response selects only judged candidates and their supports, nothing else", async () => {
  const { provider, judged } = recording(fakeProvider({ fallback: 1 }));
  const { result } = await runScope({ task: TASK, repo: ROOT, provider });
  const judgedIds = new Set(judged.map((chunk) => chunk.id));
  expect(judgedIds.size).toBeGreaterThan(0);

  const supports = result.chunks.filter((selected) => selected.supportFor);
  expect(supports.length).toBeGreaterThan(0); // the fixture does pull supports in, so the support branch is exercised
  const direct = result.chunks.filter((selected) => !selected.supportFor);
  for (const selected of direct) expect(judgedIds.has(selected.chunk.id)).toBe(true);
  // The supports are exactly the unjudged declarations the judged chunks require, computed from the fixture itself,
  // each attributed to exactly the judged chunks that require it.
  const lookup = new Map((await loadChunks(ROOT)).chunks.map((chunk) => [chunk.id, chunk]));
  const expectedSupports = new Map<string, Set<string>>();
  for (const chunk of judged) {
    for (const support of requiredSupports(chunk, lookup)) {
      if (judgedIds.has(support.id)) continue;
      expectedSupports.set(support.id, (expectedSupports.get(support.id) ?? new Set()).add(chunk.id));
    }
  }
  expect(new Set(result.chunks.map((selected) => selected.chunk.id))).toEqual(
    new Set([...judgedIds, ...expectedSupports.keys()]),
  );
  expect(result.chunks.length).toBe(judgedIds.size + expectedSupports.size);
  for (const support of supports) {
    expect(new Set(support.supportFor)).toEqual(expectedSupports.get(support.chunk.id)!);
  }
});

test("a judgment for a chunk outside the shortlist is rejected, even when every candidate is judged", async () => {
  const inner = fakeProvider({ fallback: 1 });
  const provider: DecisionProvider = {
    async decide(request) {
      const decision = await inner.decide(request);
      return { ...decision, judgments: [...decision.judgments, { chunkId: "not-a-candidate", relevance: 1 }] };
    },
  };
  await expect(runScope({ task: TASK, repo: ROOT, provider })).rejects.toThrow(JevResponseError);
});

test("a repeated judgment for one candidate is rejected", async () => {
  const inner = fakeProvider({ fallback: 1 });
  const provider: DecisionProvider = {
    async decide(request) {
      const decision = await inner.decide(request);
      return { ...decision, judgments: [...decision.judgments, decision.judgments[0]!] };
    },
  };
  await expect(runScope({ task: TASK, repo: ROOT, provider })).rejects.toThrow(/Duplicate judgment/);
});
