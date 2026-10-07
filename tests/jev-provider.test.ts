import { inspect } from "node:util";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import {
  JevAuthError,
  JevCancelledError,
  JevError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevServiceError,
  JevTimeoutError,
  JevUnavailableError,
} from "../src/jev/errors.ts";
import { main } from "../src/main.ts";
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

test("splits candidates across requests within the character limit and sums usage", async () => {
  const { client, calls } = fakeClient();
  const candidates = [chunk("a", "x".repeat(400)), chunk("b", "x".repeat(400)), chunk("c", "x".repeat(400))];
  const result = await new JevDecisionProvider({ client, batchMaxChars: 2200 }).decide({ task: "t", candidates });

  expect(calls.map((call) => Object.keys(call.questions))).toEqual([["c0", "c1"], ["c2"]]);
  expect(result.judgments.map((j) => j.chunkId)).toEqual(["a", "b", "c"]);
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 4 });
});

test("every emitted request fits the configured character limit", async () => {
  const { client, calls } = fakeClient();
  const limit = 1600;
  const candidates = Array.from({ length: 12 }, (_unused, i) => chunk(`k${i}`, "y".repeat(100 + i * 20)));
  await new JevDecisionProvider({ client, batchMaxChars: limit }).decide({ task: "t", candidates });

  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) expect(JSON.stringify(call).length).toBeLessThanOrEqual(limit);
});

test("the default limit splits large non-ASCII candidates into several requests", async () => {
  const { client, calls } = fakeClient();
  const candidates = ["a", "b", "c"].map((id) => chunk(id, "漢".repeat(9000)));
  await new JevDecisionProvider({ client }).decide({ task: "t", candidates });

  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) expect(JSON.stringify(call).length).toBeLessThanOrEqual(24_000);
});

test("refuses to send a candidate too large for any request", async () => {
  const { client, calls } = fakeClient();
  const provider = new JevDecisionProvider({ client, batchMaxChars: 200 });
  await expect(provider.decide({ task: "t", candidates: [chunk("a", "x".repeat(4000))] })).rejects.toThrow(
    JevRequestError,
  );
  expect(calls).toHaveLength(0);
});

test("rejects an oversized task before sending anything", async () => {
  const { client, calls } = fakeClient();
  const provider = new JevDecisionProvider({ client, batchMaxChars: 2000 });
  await expect(provider.decide({ task: "x".repeat(4000), candidates: [chunk("a")] })).rejects.toThrow(
    /too large to send/,
  );
  expect(calls).toHaveLength(0);
});

test("fails with JevResponseError on an untrustworthy answer instead of using it", async () => {
  const { client } = fakeClient(() => 1.5);
  await expect(new JevDecisionProvider({ client }).decide({ task: "t", candidates: [chunk("a")] })).rejects.toThrow(
    JevResponseError,
  );
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

const http = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  APIError.fromResponse(status, body, new Headers(headers));

async function decideWith(thrower: () => unknown, options: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  let attempts = 0;
  const client: JevClient = {
    async systemOne() {
      attempts++;
      throw thrower();
    },
  };
  const error = await new JevDecisionProvider({ client, deadlineMs: options.deadlineMs })
    .decide({ task: "t", candidates: [chunk("a")], signal: options.signal })
    .catch((e: unknown) => e);
  return { error, attempts };
}

test.each([
  ["HTTP 401", () => http(401), JevAuthError, /HTTP 401.*TYPESAFE_API_KEY/],
  ["HTTP 403", () => http(403), JevAuthError, /HTTP 403.*TYPESAFE_API_KEY/],
  ["HTTP 429", () => http(429), JevRateLimitError, /rate limit.*try again later/],
  ["HTTP 500", () => http(500), JevServiceError, /HTTP 500/],
  ["HTTP 529", () => http(529), JevServiceError, /HTTP 529/],
  ["connection error", () => new APIConnectionError("socket closed"), JevServiceError, /connection error/],
  ["SDK timeout", () => new APITimeoutError(30_000), JevTimeoutError, /timed out/],
  ["SDK abort without a caller signal", () => new APIUserAbortError(), JevCancelledError, /cancelled/],
  [
    "400 max_tokens_exceeded",
    () => http(400, { detail: { error_type: "max_tokens_exceeded" } }),
    JevRequestError,
    /token limit/,
  ],
  ["other 400", () => http(400, { detail: { error_type: "something_else" } }), JevServiceError, /HTTP 400/],
  ["422", () => http(422), JevServiceError, /HTTP 422/],
  ["unknown error", () => new Error("boom"), JevServiceError, /unexpectedly/],
] as const)("maps %s to its typed error, once and without retrying", async (_label, thrower, type, message) => {
  const { error, attempts } = await decideWith(thrower);
  expect(error).toBeInstanceOf(type);
  expect((error as Error).constructor).toBe(type);
  expect(error).toBeInstanceOf(JevError);
  expect((error as Error).name).toBe(type.name);
  expect((error as Error).message).toMatch(message);
  expect(attempts).toBe(1);
});

test("unavailable subclasses are JevUnavailableError, request and response errors are not", async () => {
  expect((await decideWith(() => http(401))).error).toBeInstanceOf(JevUnavailableError);
  expect(
    (await decideWith(() => http(400, { detail: { error_type: "max_tokens_exceeded" } }))).error,
  ).not.toBeInstanceOf(JevUnavailableError);
});

test("Scope's overall deadline is a timeout, not a cancellation", async () => {
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new APIUserAbortError()))),
  };
  const error = await new JevDecisionProvider({ client, deadlineMs: 20 })
    .decide({ task: "t", candidates: [chunk("a")] })
    .catch((e: unknown) => e);
  expect((error as Error).constructor).toBe(JevTimeoutError);
  expect((error as Error).message).toMatch(/deadline/);
});

test("the caller's signal is a cancellation, whatever the SDK threw", async () => {
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new APITimeoutError(1)))),
  };
  const controller = new AbortController();
  const pending = new JevDecisionProvider({ client }).decide({
    task: "t",
    candidates: [chunk("a")],
    signal: controller.signal,
  });
  controller.abort();
  const error = await pending.catch((e: unknown) => e);
  expect((error as Error).constructor).toBe(JevCancelledError);
});

test("a missing key is a JevAuthError", () => {
  delete process.env.TYPESAFE_API_KEY;
  expect(() => createJevClient()).toThrow(JevAuthError);
  expect(() => createJevClient({ attemptTimeoutMs: 5 })).toThrow(JevAuthError);
});

test("createJevClient accepts a per-attempt timeout", () => {
  process.env.TYPESAFE_API_KEY = "fake-key-for-construction";
  expect(createJevClient({ attemptTimeoutMs: 1234 }).systemOne).toBeFunction();
});

const FAKE_KEY = "sk-fake-DISTINCT-key-9f8e7d6c";

function leakyErrors(): unknown[] {
  const leak = `Authorization: Bearer ${FAKE_KEY} for source code SECRET_SOURCE`;
  const body = { detail: leak, echoed: { key: FAKE_KEY } };
  const headers = { "x-api-key": FAKE_KEY, "x-typesafe-request-id": "req-123" };
  const withCause = (error: Error) => Object.assign(error, { cause: new Error(leak) });
  return [
    ...[400, 401, 403, 422, 429, 500, 529].map((status) => withCause(http(status, body, headers))),
    http(400, { detail: { error_type: "max_tokens_exceeded", echoed: leak } }, headers),
    withCause(new APIConnectionError(leak)),
    withCause(new APITimeoutError(1)),
    withCause(new APIUserAbortError(leak)),
    new Error(leak),
  ];
}

test("API keys and echoed content never appear in an error's message, string form or stack", async () => {
  process.env.TYPESAFE_API_KEY = FAKE_KEY;
  for (const sdkError of leakyErrors()) {
    const { error } = await decideWith(() => sdkError);
    expect(error).toBeInstanceOf(JevError);
    for (const text of [(error as Error).message, String(error), (error as Error).stack ?? "", inspect(error)]) {
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("SECRET_SOURCE");
    }
  }
});

test("the CLI never prints the key or echoed content, and prints nothing to stdout on failure", async () => {
  process.env.TYPESAFE_API_KEY = FAKE_KEY;
  for (const sdkError of leakyErrors()) {
    const out: string[] = [];
    const err: string[] = [];
    const client: JevClient = {
      async systemOne() {
        throw sdkError;
      },
    };
    const code = await main(["Add retry handling", "--repo", join(import.meta.dir, "../fixtures/webhook-service")], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      provider: new JevDecisionProvider({ client }),
    });
    expect(code).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).not.toContain(FAKE_KEY);
    expect(err.join("")).not.toContain("SECRET_SOURCE");
  }
});

test("cancelling through the CLI signal exits non-zero with one stderr line and nothing on stdout", async () => {
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new APIUserAbortError()))),
  };
  const controller = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const running = main(["Add retry handling", "--repo", join(import.meta.dir, "../fixtures/webhook-service")], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    provider: new JevDecisionProvider({ client }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const code = await running;

  expect(code).not.toBe(0);
  expect(out.join("")).toBe("");
  expect(err.join("").trimEnd().split("\n")).toHaveLength(1);
  expect(err.join("")).toMatch(/^scope: Cancelled: /);
});

test("a cancelled signal stops a --no-jev run after the scan, with nothing on stdout", async () => {
  const controller = new AbortController();
  controller.abort();
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["Add retry handling", "--no-jev", "--repo", join(import.meta.dir, "../fixtures/webhook-service")],
    { stdout: (t) => out.push(t), stderr: (t) => err.push(t), signal: controller.signal },
  );

  expect(code).toBe(1);
  expect(out.join("")).toBe("");
  expect(err.join("")).toBe("scope: Cancelled: the run was interrupted before it finished\n");
});
