import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JevResponseError, JevUnavailableError } from "../src/jev/errors.ts";
import { runScope } from "../src/scope.ts";
import { renderResult } from "../src/output/text.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";
const provider = fakeProvider({ relevance: { withRetry: 0.9, computeBackoff: 0.8, handleStripeWebhook: 0.7 } });

test("fixture + real parser + fake provider selects the relevant chunks with exact source locations", async () => {
  const { result } = await runScope({ task: TASK, repo: FIXTURE, provider });
  expect(result.chunks.map((s) => s.chunk.name).sort()).toEqual(["computeBackoff", "handleStripeWebhook", "withRetry"]);

  for (const { chunk } of result.chunks) {
    const lines = (await readFile(join(FIXTURE, chunk.file), "utf8")).split("\n");
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(renderResult(result)).toContain(`== ${chunk.file}:${chunk.startLine}-${chunk.endLine} `);
  }
});

test("a small budget keeps the artifact within it", async () => {
  const { result } = await runScope({ task: TASK, repo: FIXTURE, provider, budget: 120 });
  expect(result.chunks.length).toBeGreaterThan(0);
  expect(result.chunks.length).toBeLessThan(3);
  expect(result.estimatedTokens).toBeLessThanOrEqual(120);
});

test.each([
  ["timeout", JevUnavailableError],
  ["malformed", JevResponseError],
  ["partial", JevResponseError],
] as const)("an injected %s failure fails the run instead of producing a result", async (failure, errorType) => {
  const run = runScope({ task: TASK, repo: FIXTURE, provider: fakeProvider({ failure }) });
  await expect(run).rejects.toBeInstanceOf(errorType);
});
