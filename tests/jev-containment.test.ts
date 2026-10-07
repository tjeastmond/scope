import { expect, test } from "bun:test";
import { join } from "node:path";
import { JevResponseError } from "../src/jev/errors.ts";
import { runScope } from "../src/scope.ts";
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
  // A support is pulled in by a selected chunk, is never a duplicate of a judged selection, and is not itself judged.
  const selectedIds = new Set(result.chunks.map((selected) => selected.chunk.id));
  expect(selectedIds.size).toBe(result.chunks.length);
  for (const support of supports) {
    expect(judgedIds.has(support.chunk.id)).toBe(false);
    for (const requirer of support.supportFor!) expect(selectedIds.has(requirer)).toBe(true);
  }
  // Every judged candidate is accounted for, none is invented, and the artifact is no larger than their union.
  expect(direct.length).toBe(judged.length);
  expect(result.chunks.length).toBe(direct.length + supports.length);
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
