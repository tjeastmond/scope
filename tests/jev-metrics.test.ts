import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { JevDecisionProvider, type JevClient } from "../src/jev/provider.ts";
import { main, type Io } from "../src/main.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "docs/scope-result.schema.json"), "utf8")),
);

const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(() => delete process.env.TYPESAFE_API_KEY);
afterEach(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
});

async function run(argv: string[], provider?: DecisionProvider) {
  const out: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: () => {}, provider };
  expect(await main([TASK, "--repo", FIXTURE, ...argv], io)).toBe(0);
  return out.join("");
}

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

test("provider reports per-request metrics in plan order, each with its own usage and latency", async () => {
  // Request 0 answers last and request 2 first, so completion order differs from plan order.
  const delays = [60, 30, 0];
  const client: JevClient = {
    async systemOne(request) {
      const ref = Object.keys(request.questions)[0]!;
      const index = Number(ref.slice(1));
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      const answers = Object.fromEntries(Object.keys(request.questions).map((r) => [r, { type: "noul", noul: 0.5 }]));
      return { answers, usage: { input_tokens: 100 * (index + 1), output_tokens: index + 1 } };
    },
  };
  const result = await new JevDecisionProvider({ client, batchMaxQuestions: 1, concurrency: 3 }).decide({
    task: "t",
    candidates: [chunk("a"), chunk("b"), chunk("c")],
  });

  expect(result.requests?.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens }))).toEqual([
    { inputTokens: 100, outputTokens: 1 },
    { inputTokens: 200, outputTokens: 2 },
    { inputTokens: 300, outputTokens: 3 },
  ]);
  expect(result.usage).toEqual({ inputTokens: 600, outputTokens: 6 });
  const [first, second, third] = result.requests!;
  expect(first!.latencyMs).toBeGreaterThanOrEqual(55);
  expect(second!.latencyMs).toBeGreaterThanOrEqual(25);
  expect(third!.latencyMs).toBeLessThan(first!.latencyMs);
  for (const request of result.requests!) expect(Number.isInteger(request.latencyMs)).toBe(true);
  // Requests overlap: the wall clock is below the sum of the per-request latencies.
  const sum = result.requests!.reduce((total, request) => total + request.latencyMs, 0);
  expect(Number.isInteger(result.latencyMs)).toBe(true);
  expect(result.latencyMs!).toBeLessThan(sum);
});

test("JSON reports jev usage, latency and request count, and per-request detail only with --explain", async () => {
  const plain = JSON.parse(await run(["--format", "json"], fakeProvider()));
  expect(validate(plain)).toBe(true);
  expect(Object.keys(plain.jev)).toEqual(["requestCount", "latencyMs", "usage"]);
  expect(plain.jev).toEqual({ requestCount: 1, latencyMs: 3, usage: { inputTokens: 5, outputTokens: 1 } });

  const explained = JSON.parse(await run(["--format", "json", "--explain"], fakeProvider()));
  expect(validate(explained)).toBe(true);
  expect(Object.keys(explained.jev)).toEqual(["requestCount", "latencyMs", "usage", "requests"]);
  expect(explained.jev.requests).toEqual([{ latencyMs: 3, inputTokens: 5, outputTokens: 1 }]);
});

test("--no-jev JSON has no jev key", async () => {
  for (const argv of [["--no-jev"], ["--no-jev", "--explain"]]) {
    const payload = JSON.parse(await run([...argv, "--format", "json"]));
    expect(validate(payload)).toBe(true);
    expect(payload).not.toHaveProperty("jev");
  }
});

test("no candidates means Jev is not called and there is no jev key", async () => {
  let called = false;
  const provider: DecisionProvider = {
    decide: async () => {
      called = true;
      throw new Error("must not be called");
    },
  };
  const out: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: () => {}, provider };
  const empty = await mkdtemp(join(tmpdir(), "scope-empty-"));
  const code = await main(["zzzz qqqq", "--repo", empty, "--format", "json"], io);
  await rm(empty, { recursive: true });
  expect(code).toBe(0);
  const payload = JSON.parse(out.join(""));
  expect(payload.regions).toEqual([]);
  expect(payload).not.toHaveProperty("jev");
  expect(called).toBe(false);
});

test("a provider that reports no usage or latency yields no jev key rather than invented numbers", async () => {
  const provider: DecisionProvider = {
    decide: async ({ candidates }) => ({ judgments: candidates.map((c) => ({ chunkId: c.id, relevance: 0.9 })) }),
  };
  const payload = JSON.parse(await run(["--format", "json"], provider));
  expect(payload).not.toHaveProperty("jev");
});

test("malformed per-request entries are dropped, keeping the validated totals", async () => {
  const provider: DecisionProvider = {
    decide: async ({ candidates }) => ({
      judgments: candidates.map((c) => ({ chunkId: c.id, relevance: 0.9 })),
      usage: { inputTokens: 5, outputTokens: 1 },
      latencyMs: 3,
      requests: [{ latencyMs: -1, inputTokens: 5, outputTokens: Number.NaN }],
    }),
  };
  const payload = JSON.parse(await run(["--format", "json", "--explain"], provider));
  expect(payload.jev).toEqual({ latencyMs: 3, usage: { inputTokens: 5, outputTokens: 1 } });
  expect(validate(payload)).toBe(true);
});

test("text and Markdown show the Jev lines only under --explain", async () => {
  for (const format of ["text", "markdown"]) {
    const plain = await run(["--format", format], fakeProvider());
    expect(plain).not.toContain("Jev requests");
    expect(plain).not.toContain("Jev latency");
    expect(plain).not.toContain("Jev tokens");
    const explained = await run(["--format", format, "--explain"], fakeProvider());
    expect(explained).toContain("Jev requests: 1");
    expect(explained).toContain("Jev latency: 3 ms (wall clock)");
    expect(explained).toContain("Jev tokens: 5 input / 1 output");
  }
});
