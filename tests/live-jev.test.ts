import { expect, test } from "bun:test";
import { join } from "node:path";
import { JevDecisionProvider } from "../src/jev/provider.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const live = process.env.SCOPE_LIVE_JEV === "1" && Boolean(process.env.TYPESAFE_API_KEY?.trim());

/** Records the candidates Jev was asked to judge, so the answers can be checked against them. */
function recording(inner: DecisionProvider) {
  const asked: CodeChunk[] = [];
  const provider: DecisionProvider = {
    decide: (request) => {
      asked.push(...request.candidates);
      return inner.decide(request);
    },
  };
  return { provider, asked };
}

// Opt-in: costs real API calls. Run with SCOPE_LIVE_JEV=1 and TYPESAFE_API_KEY set. Never part of ordinary CI.
// Prints usage numbers and latency only, never the key, request bodies or error bodies.
test.skipIf(!live)(
  "live Jev: one finite judgment per candidate, by candidate id, with usage reported",
  async () => {
    const { provider, asked } = recording(new JevDecisionProvider());
    const { result, decision } = await runScope({
      task: "Add retry handling to Stripe webhook processing",
      repo: join(FIXTURES, "webhook-service"),
      provider,
    });
    console.log(`live Jev usage: ${JSON.stringify(decision?.usage)}, ${decision?.latencyMs}ms`);

    const ids = asked.map((chunk) => chunk.id);
    expect(ids.length).toBeGreaterThan(0);
    // Candidate identification: exactly one judgment per candidate, and no id that was not shortlisted.
    expect(decision!.judgments.map((j) => j.chunkId).sort()).toEqual([...ids].sort());
    // Response mapping: every relevance is finite and in [0, 1].
    for (const { relevance } of decision!.judgments) {
      expect(Number.isFinite(relevance)).toBe(true);
      expect(relevance).toBeGreaterThanOrEqual(0);
      expect(relevance).toBeLessThanOrEqual(1);
    }
    expect(decision?.usage?.inputTokens).toBeGreaterThan(0);
    expect(decision?.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.chunks.some(({ chunk }) => /retry|webhook/i.test(chunk.name ?? ""))).toBe(true);
  },
  120_000,
);

test.skipIf(!live)(
  "live Jev: a shortlist split into several requests is judged once per candidate with per-request usage",
  async () => {
    const { provider, asked } = recording(new JevDecisionProvider({ batchMaxQuestions: 4 }));
    const { decision } = await runScope({
      task: "Show each invoice due date in the invoice list and query it in SQL",
      repo: join(FIXTURES, "mixed-app"),
      provider,
    });
    const requests = decision!.requests!;
    console.log(
      `live Jev batched: ${asked.length} candidates, ${requests.length} requests, usage ${JSON.stringify(decision!.usage)}, ` +
        `${decision!.latencyMs}ms, per-request ${JSON.stringify(requests)}`,
    );

    expect(requests.length).toBe(Math.ceil(asked.length / 4));
    expect(requests.length).toBeGreaterThan(1);
    // Judgments come back in plan (candidate) order, one per candidate.
    expect(decision!.judgments.map((j) => j.chunkId)).toEqual(asked.map((chunk) => chunk.id));
    for (const request of requests) {
      expect(request.inputTokens).toBeGreaterThan(0);
      expect(request.outputTokens).toBeGreaterThan(0);
    }
    expect(decision!.usage!.inputTokens).toBe(requests.reduce((sum, r) => sum + r.inputTokens, 0));
    expect(decision!.usage!.outputTokens).toBe(requests.reduce((sum, r) => sum + r.outputTokens, 0));
  },
  180_000,
);
