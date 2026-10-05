import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";

function capture(provider?: DecisionProvider) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

/** Fake Jev: chunks whose name contains `retry` (case-insensitive) are relevant. */
const fakeProvider: DecisionProvider = {
  async decide({ candidates }) {
    const judge = (chunk: CodeChunk) => (/retry|backoff/i.test(chunk.name ?? "") ? 0.9 : 0.1);
    return {
      judgments: candidates.map((chunk) => ({ chunkId: chunk.id, relevance: judge(chunk) })),
      usage: { inputTokens: 5, outputTokens: 1 },
      latencyMs: 3,
    };
  },
};

const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(() => delete process.env.TYPESAFE_API_KEY);
afterEach(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
});

test("--no-jev runs without credentials and prints exact locations", async () => {
  const run = capture();
  expect(await main([TASK, "--repo", FIXTURE, "--no-jev"], run.io)).toBe(0);
  expect(run.stdout()).toContain("== src/util/retry.ts:");
  expect(run.stderr()).not.toContain("Jev");
});

test("with a decision provider, selects the chunks it judged relevant and reports usage on stderr", async () => {
  const run = capture(fakeProvider);
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(0);
  expect(run.stdout()).toContain("withRetry");
  expect(run.stdout()).toContain("computeBackoff");
  expect(run.stdout()).not.toContain("renderProfile");
  expect(run.stderr()).toContain("Jev 3ms, 5 input / 1 output tokens");
});

test("the default path without a key fails with guidance and prints nothing to stdout", async () => {
  const run = capture();
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(1);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toMatch(/TYPESAFE_API_KEY is not set.*--no-jev/);
});

test("an incomplete provider response fails instead of becoming offline-style results", async () => {
  const run = capture({ decide: async () => ({ judgments: [], usage: {}, latencyMs: 1 }) });
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(1);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toContain("Missing judgments");
});

test("ignored and secret-looking files never reach the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-cli-"));
  try {
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "private/\n");
    await writeFile(join(root, "ok.ts"), "export function ok() {}\n");
    await writeFile(join(root, "private/hidden.ts"), "export function hiddenIgnored() {}\n");
    await writeFile(join(root, "credentials.ts"), "export function hiddenSecret() {}\n");
    await writeFile(join(root, "binary.ts"), "export function hiddenBinary() {}\0\n");
    const seen: string[] = [];
    const spy: DecisionProvider = {
      async decide({ candidates }) {
        seen.push(...candidates.map((chunk) => chunk.content));
        return {
          judgments: candidates.map((chunk) => ({ chunkId: chunk.id, relevance: 0.9 })),
          usage: {},
          latencyMs: 1,
        };
      },
    };
    const run = capture(spy);
    expect(await main([TASK, "--repo", root], run.io)).toBe(0);
    expect(seen.join("\n")).toContain("ok");
    expect(seen.join("\n")).not.toMatch(/hiddenIgnored|hiddenSecret|hiddenBinary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports Jev metrics only when the provider supplies them", async () => {
  const run = capture({
    decide: async ({ candidates }) => ({ judgments: candidates.map((c) => ({ chunkId: c.id, relevance: 0.9 })) }),
  });
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(0);
  expect(run.stderr()).toContain("Jev usage not reported");
  expect(run.stderr()).not.toContain("undefined");
});

test("usage errors exit 2 with a message and no stdout", async () => {
  for (const argv of [
    [TASK, "--repo", "/nonexistent/dir"],
    [TASK, "--budget", "abc"],
    ["a", "b"],
    [TASK, "--bogus"],
  ]) {
    const run = capture();
    expect(await main(argv, run.io)).toBe(2);
    expect(run.stdout()).toBe("");
    expect(run.stderr()).toStartWith("scope: ");
  }
});

test("no arguments prints help", async () => {
  const run = capture();
  expect(await main([], run.io)).toBe(0);
  expect(run.stdout()).toContain("Usage: scope");
});

test("the budget is respected", async () => {
  const run = capture();
  expect(await main([TASK, "--repo", FIXTURE, "--no-jev", "--budget", "300"], run.io)).toBe(0);
  expect(Math.ceil(run.stdout().length / 4)).toBeLessThanOrEqual(300);
});

const built = existsSync(join(ROOT, "dist/cli.js"));
test.skipIf(!built)("compiled CLI under Node: --no-jev works, default path without a key exits non-zero", async () => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["node", "dist/cli.js", TASK, "--repo", FIXTURE, ...args], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { stdout, stderr, code: await proc.exited };
  };
  const offline = await run("--no-jev");
  expect(offline.code).toBe(0);
  expect(offline.stdout).toContain("== src/");
  const online = await run();
  expect(online.code).toBe(1);
  expect(online.stdout).toBe("");
  expect(online.stderr).toContain("TYPESAFE_API_KEY");
});
