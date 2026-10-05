import { expect, test } from "bun:test";
import { join } from "node:path";
import { runScope } from "../src/scope.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/webhook-service");
const live = process.env.SCOPE_LIVE_JEV === "1" && Boolean(process.env.TYPESAFE_API_KEY?.trim());

// Opt-in: costs real API calls. Run with SCOPE_LIVE_JEV=1 and TYPESAFE_API_KEY set. Never part of ordinary CI.
test.skipIf(!live)(
  "live Jev judges the fixture's candidates, maps answers to chunks and reports usage",
  async () => {
    const { result, decision } = await runScope({
      task: "Add retry handling to Stripe webhook processing",
      repo: FIXTURE,
    });
    console.log(`live Jev usage: ${JSON.stringify(decision?.usage)}, ${decision?.latencyMs}ms`);
    expect(decision?.judgments.length).toBeGreaterThan(0);
    expect(decision?.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.chunks.some(({ chunk }) => /retry|webhook/i.test(chunk.name ?? ""))).toBe(true);
  },
  120_000,
);
