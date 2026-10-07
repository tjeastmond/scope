import { expect, test } from "bun:test";
import { APIError } from "@typesafe-ai/sdk";
import { JevCancelledError, JevRequestError, JevResponseError, JevServiceError } from "../src/jev/errors.ts";
import { JevDecisionProvider, planJevRequests, type JevClient, type JevRequest } from "../src/jev/provider.ts";
import type { CodeChunk } from "../src/types.ts";

const chunk = (id: string): CodeChunk => ({
  id,
  file: `${id}.ts`,
  language: "typescript",
  kind: "function",
  name: id,
  startLine: 1,
  endLine: 2,
  content: "code",
  references: [],
});

const many = (n: number) => Array.from({ length: n }, (_unused, i) => chunk(`k${i}`));
/** The relevance a candidate gets, derived from its file so a mixup between candidates shows. */
const valueOf = (request: JevRequest, ref: string) => {
  const index = Number(
    ((request.state.candidates as Record<string, { path: string }>)[ref]!.path.match(/\d+/) ?? [])[0],
  );
  return index / 100;
};
const answersFor = (request: JevRequest) =>
  Object.fromEntries(Object.keys(request.questions).map((ref) => [ref, { type: "noul", noul: valueOf(request, ref) }]));
const usage = { input_tokens: 5, output_tokens: 1 };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("splits a large shortlist by question count and judges every candidate once, in order", async () => {
  const sizes: number[] = [];
  const client: JevClient = {
    async systemOne(request) {
      sizes.push(Object.keys(request.questions).length);
      return { answers: answersFor(request), usage };
    },
  };
  const candidates = many(40);
  const result = await new JevDecisionProvider({ client, batchMaxQuestions: 16 }).decide({ task: "t", candidates });

  expect(sizes.sort((a, b) => b - a)).toEqual([16, 16, 8]);
  expect(result.judgments.map((j) => j.chunkId)).toEqual(candidates.map((c) => c.id));
  expect(result.judgments.map((j) => j.relevance)).toEqual(candidates.map((_c, i) => i / 100));
  expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
});

test("planJevRequests honours the question limit and matches what the provider sends", async () => {
  const candidates = many(40);
  const planned = planJevRequests("t", candidates, { batchMaxQuestions: 16 });
  expect(planned.map((r) => Object.keys(r.questions).length)).toEqual([16, 16, 8]);
  expect(Object.keys(planned[1]!.questions)[0]).toBe("c16");

  const sent: JevRequest[] = [];
  const client: JevClient = {
    async systemOne(request) {
      sent.push(request);
      return { answers: answersFor(request), usage };
    },
  };
  await new JevDecisionProvider({ client, batchMaxQuestions: 16, concurrency: 1 }).decide({ task: "t", candidates });
  expect(sent).toEqual(planned);
});

test("rejects nonsense limits", () => {
  const client: JevClient = { systemOne: () => Promise.reject(new Error("unused")) };
  expect(() => new JevDecisionProvider({ client, concurrency: 0 })).toThrow(/concurrency/);
  expect(() => new JevDecisionProvider({ client, batchMaxQuestions: 1.5 })).toThrow(/batchMaxQuestions/);
  expect(() => planJevRequests("t", many(2), { batchMaxQuestions: 0 })).toThrow(/batchMaxQuestions/);
});

test("runs at most `concurrency` requests at once, and more than one", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const client: JevClient = {
    async systemOne(request) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return { answers: answersFor(request), usage };
    },
  };
  const result = await new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 2 }).decide({
    task: "t",
    candidates: many(12),
  });
  expect(maxInFlight).toBe(2);
  expect(result.judgments).toHaveLength(12);
});

test("merges by candidate even when batches finish in reverse order", async () => {
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  let started = 0;
  const client: JevClient = {
    async systemOne(request) {
      await gates[started++]!.promise;
      return { answers: answersFor(request), usage };
    },
  };
  const candidates = many(6);
  const pending = new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 3 }).decide({
    task: "t",
    candidates,
  });
  await tick();
  expect(started).toBe(3);
  gates[2]!.resolve();
  await tick();
  gates[1]!.resolve();
  await tick();
  gates[0]!.resolve();
  const result = await pending;
  expect(result.judgments.map((j) => j.chunkId)).toEqual(candidates.map((c) => c.id));
  expect(result.judgments.map((j) => j.relevance)).toEqual(candidates.map((_c, i) => i / 100));
});

test("a failing batch aborts in-flight siblings, starts nothing more and returns no partial result", async () => {
  const signals: AbortSignal[] = [];
  const gate = deferred<void>();
  let calls = 0;
  const client: JevClient = {
    async systemOne(request, { signal }) {
      const n = calls++;
      signals.push(signal);
      if (n === 1) {
        await tick();
        throw APIError.fromResponse(500, {}, new Headers());
      }
      // The siblings hang until aborted, then fail like the SDK does.
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        void gate.promise;
      });
      return { answers: answersFor(request), usage };
    },
  };
  const error = await new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 3 })
    .decide({ task: "t", candidates: many(8) })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JevServiceError);
  expect((error as Error).message).toContain("HTTP 500");
  expect(calls).toBe(3);
  expect(signals.map((s) => s.aborted)).toEqual([true, true, true]);
});

test("with concurrency 1 no batch starts after a failure", async () => {
  let calls = 0;
  const client: JevClient = {
    async systemOne(request) {
      if (calls++ === 1) throw APIError.fromResponse(500, {}, new Headers());
      return { answers: answersFor(request), usage };
    },
  };
  const error = await new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 1 })
    .decide({ task: "t", candidates: many(6) })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JevServiceError);
  expect(calls).toBe(2);
});

test("a batch with a missing answer fails the run", async () => {
  let calls = 0;
  const client: JevClient = {
    async systemOne(request) {
      const answers = answersFor(request);
      if (calls++ === 1) delete answers[Object.keys(answers)[0]!];
      return { answers, usage };
    },
  };
  const error = await new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 2 })
    .decide({ task: "t", candidates: many(6) })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JevResponseError);
});

test("duplicate chunk IDs in different batches fail before anything is sent", async () => {
  let calls = 0;
  const client: JevClient = {
    async systemOne(request) {
      calls++;
      return { answers: answersFor(request), usage };
    },
  };
  const candidates = [...many(4), chunk("k0")];
  const error = await new JevDecisionProvider({ client, batchMaxQuestions: 2 })
    .decide({ task: "t", candidates })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JevRequestError);
  expect((error as Error).message).toContain("k0");
  expect(calls).toBe(0);
});

test("cancelling the caller during concurrent batches reports a cancellation", async () => {
  const controller = new AbortController();
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const pending = new JevDecisionProvider({ client, batchMaxQuestions: 2, concurrency: 3 })
    .decide({ task: "t", candidates: many(8), signal: controller.signal })
    .catch((e: unknown) => e);
  await tick();
  controller.abort();
  expect(await pending).toBeInstanceOf(JevCancelledError);
});
