import { inspect } from "node:util";
import { afterEach, expect, test } from "bun:test";
import { JevRequestError, JevResponseError, JevUnavailableError } from "../src/jev/errors.ts";
import { createJevClient, JevDecisionProvider, type JevClient } from "../src/jev/provider.ts";
import type { CodeChunk } from "../src/types.ts";

type Call = { state: Record<string, unknown>; questions: Record<string, unknown> };

const chunk = (id: string, content = "code"): CodeChunk => ({
  id,
  file: `${id}.ts`,
  language: "typescript",
  kind: "function",
  name: id,
  startLine: 1,
  endLine: 2,
  content,
  references: [],
  estimatedTokens: 1,
});

function fakeClient(relevance: (ref: string) => unknown = () => 0.7) {
  const calls: Call[] = [];
  const client: JevClient = {
    async systemOne(request) {
      calls.push(request);
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((ref) => [ref, { type: "noul", noul: relevance(ref) }]),
      );
      return { answers, usage: { input_tokens: 10, output_tokens: 2 } };
    },
  };
  return { client, calls };
}

test("asks one Noul per candidate that names the candidate, and maps answers back to chunk IDs", async () => {
  const { client, calls } = fakeClient((ref) => (ref === "c0" ? 0.9 : 0.1));
  const result = await new JevDecisionProvider({ client }).decide({
    task: "fix it",
    candidates: [chunk("a"), chunk("b")],
  });

  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]!.questions)).toEqual(["c0", "c1"]);
  expect(JSON.stringify(calls[0]!.questions.c1)).toContain("candidates.c1");
  expect(calls[0]!.state.task).toBe("fix it");
  expect(result.judgments.map(({ chunkId, relevance }) => ({ chunkId, relevance }))).toEqual([
    { chunkId: "a", relevance: 0.9 },
    { chunkId: "b", relevance: 0.1 },
  ]);
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});

test("splits candidates across requests within the token budget and sums usage", async () => {
  const { client, calls } = fakeClient();
  const candidates = [chunk("a", "x".repeat(400)), chunk("b", "x".repeat(400)), chunk("c", "x".repeat(400))];
  const result = await new JevDecisionProvider({ client, batchTokenBudget: 450 }).decide({ task: "t", candidates });

  expect(calls.map((call) => Object.keys(call.questions))).toEqual([["c0", "c1"], ["c2"]]);
  expect(result.judgments.map((j) => j.chunkId)).toEqual(["a", "b", "c"]);
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 4 });
});

test("refuses to send a candidate too large for any request", async () => {
  const { client, calls } = fakeClient();
  const provider = new JevDecisionProvider({ client, batchTokenBudget: 50 });
  await expect(provider.decide({ task: "t", candidates: [chunk("a", "x".repeat(4000))] })).rejects.toThrow(
    JevRequestError,
  );
  expect(calls).toHaveLength(0);
});

test("rejects an oversized task before sending anything", async () => {
  const { client, calls } = fakeClient();
  const provider = new JevDecisionProvider({ client, batchTokenBudget: 500 });
  await expect(provider.decide({ task: "x".repeat(4000), candidates: [chunk("a")] })).rejects.toThrow(
    /task description/,
  );
  expect(calls).toHaveLength(0);
});

test("fails with JevResponseError on an untrustworthy answer instead of using it", async () => {
  const { client } = fakeClient(() => 1.5);
  await expect(new JevDecisionProvider({ client }).decide({ task: "t", candidates: [chunk("a")] })).rejects.toThrow(
    JevResponseError,
  );
});

test("wraps SDK failures without echoing their message, and does not retry on its own", async () => {
  let attempts = 0;
  const client: JevClient = {
    async systemOne() {
      attempts++;
      throw Object.assign(new Error("secret-key-abc and source code"), { status: 503 });
    },
  };
  const error = await new JevDecisionProvider({ client })
    .decide({ task: "t", candidates: [chunk("a")] })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(JevUnavailableError);
  expect((error as Error).message).toContain("HTTP 503");
  expect((error as Error).message).not.toContain("secret-key-abc");
  expect(inspect(error)).not.toContain("secret-key-abc");
  expect(attempts).toBe(1);
});

test("enforces the overall deadline and caller cancellation through the abort signal", async () => {
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const request = { task: "t", candidates: [chunk("a")] };
  await expect(new JevDecisionProvider({ client, deadlineMs: 20 }).decide(request)).rejects.toThrow(/timed out/);

  const controller = new AbortController();
  const pending = new JevDecisionProvider({ client }).decide({ ...request, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow(JevUnavailableError);
});

const savedKey = process.env.TYPESAFE_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
});

test("fails clearly when the API key is missing and never names the variable's value", () => {
  delete process.env.TYPESAFE_API_KEY;
  expect(() => createJevClient()).toThrow(/TYPESAFE_API_KEY is not set.*--no-jev/);
  process.env.TYPESAFE_API_KEY = "   ";
  expect(() => createJevClient()).toThrow(JevUnavailableError);
  expect(() => new JevDecisionProvider()).toThrow(JevUnavailableError);
});
