import { afterEach, beforeEach, expect, test } from "bun:test";
import { JEV_MAX_RETRIES } from "../src/config.ts";
import { JevCancelledError, JevServiceError, JevTimeoutError } from "../src/jev/errors.ts";
import { createJevClient, JevDecisionProvider, type JevClient } from "../src/jev/provider.ts";
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
const candidates = Array.from({ length: 6 }, (_unused, i) => chunk(`k${i}`));
/** Timer and scheduling slack allowed beyond a deadline. */
const SLACK_MS = 250;

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fake-key-for-deadline-tests";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
});

async function timed(run: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const started = performance.now();
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { error, ms: performance.now() - started };
}

test("a client that always times out fails the run with a timeout within the overall deadline", async () => {
  // Every request hangs until its signal fires, as a timed-out attempt would.
  const client: JevClient = {
    systemOne: (_request, { signal }) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const provider = new JevDecisionProvider({ client, deadlineMs: 200, batchMaxQuestions: 1, concurrency: 2 });
  const { error, ms } = await timed(() => provider.decide({ task: "t", candidates }));
  expect(error).toBeInstanceOf(JevTimeoutError);
  expect((error as Error).message).toMatch(/deadline/);
  expect(ms).toBeLessThan(200 + SLACK_MS);
});

test("the deadline holds even when a request ignores its signal", async () => {
  const client: JevClient = { systemOne: () => new Promise(() => {}) };
  const provider = new JevDecisionProvider({ client, deadlineMs: 200 });
  const { error, ms } = await timed(() => provider.decide({ task: "t", candidates }));
  expect(error).toBeInstanceOf(JevTimeoutError);
  expect(ms).toBeLessThan(200 + SLACK_MS);
});

test("a Ctrl-C is reported as a cancellation even when a request ignores its signal", async () => {
  const client: JevClient = { systemOne: () => new Promise(() => {}) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const provider = new JevDecisionProvider({ client, deadlineMs: 5_000 });
  const { error, ms } = await timed(() => provider.decide({ task: "t", candidates, signal: controller.signal }));
  expect(error).toBeInstanceOf(JevCancelledError);
  expect(ms).toBeLessThan(50 + SLACK_MS);
});

test("with the real SDK, attempts that keep timing out end at the overall deadline", async () => {
  let attempts = 0;
  // A transport that never answers; it only gives up when the SDK aborts the attempt.
  const fetch = ((_url: unknown, init?: RequestInit) => {
    attempts += 1;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
    );
  }) as typeof globalThis.fetch;
  const client = createJevClient({ fetch, attemptTimeoutMs: 100 });
  // The second attempt starts after the 100 ms timeout plus about 0.5 s of backoff; the third would follow about 1 s later.
  const provider = new JevDecisionProvider({ client, deadlineMs: 800 });
  const { error, ms } = await timed(() => provider.decide({ task: "t", candidates }));
  expect(error).toBeInstanceOf(JevTimeoutError);
  expect(ms).toBeLessThan(800 + SLACK_MS);
  // The SDK retried timed-out attempts rather than giving up after the first.
  expect(attempts).toBe(2);
});

test("the SDK makes exactly JEV_MAX_RETRIES retries, and Scope adds none of its own", async () => {
  let attempts = 0;
  const fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ detail: "unavailable" }), {
      status: 503,
      headers: { "retry-after-ms": "0" },
    });
  }) as unknown as typeof globalThis.fetch;
  const provider = new JevDecisionProvider({ client: createJevClient({ fetch }) });
  const { error } = await timed(() => provider.decide({ task: "t", candidates: candidates.slice(0, 1) }));
  expect(error).toBeInstanceOf(JevServiceError);
  expect(attempts).toBe(JEV_MAX_RETRIES + 1);
});

test("a long server Retry-After is not honoured; the SDK falls back to its short backoff", async () => {
  let attempts = 0;
  const fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ detail: "slow down" }), { status: 429, headers: { "retry-after": "60" } });
  }) as unknown as typeof globalThis.fetch;
  const provider = new JevDecisionProvider({ client: createJevClient({ fetch }) });
  const { ms } = await timed(() => provider.decide({ task: "t", candidates: candidates.slice(0, 1) }));
  expect(attempts).toBe(JEV_MAX_RETRIES + 1);
  // Backoff is 0.5 s then 1 s (less jitter); honouring 60 s would take two minutes.
  expect(ms).toBeLessThan(3_000);
}, 10_000);
