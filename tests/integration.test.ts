import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const { result } = await runScope({ task: TASK, repo: FIXTURE, provider, budget: 400 });
  expect(result.chunks.length).toBeGreaterThan(0);
  expect(result.chunks.length).toBeLessThan(3);
  expect(result.estimatedTokens).toBeLessThanOrEqual(400);
});

test.each([
  ["timeout", JevUnavailableError],
  ["malformed", JevResponseError],
  ["partial", JevResponseError],
] as const)("an injected %s failure fails the run instead of producing a result", async (failure, errorType) => {
  const run = runScope({ task: TASK, repo: FIXTURE, provider: fakeProvider({ failure }) });
  await expect(run).rejects.toBeInstanceOf(errorType);
});

test("analyzes every file whose language has an analyzer, found by extension or shebang, and falls back to text windows for the rest", async () => {
  const repo = await mkdtemp(join(tmpdir(), "scope-classify-"));
  try {
    await mkdir(join(repo, "bin"));
    await writeFile(join(repo, "a.py"), "def from_py():\n    pass\n");
    await writeFile(join(repo, "b.mjs"), "export function fromMjs() {}\n");
    await writeFile(join(repo, "bin/tool"), "#!/usr/bin/env python3\ndef from_shebang():\n    pass\n");
    await writeFile(join(repo, "bin/node-tool"), "#!/usr/bin/env node\nfunction fromNode(a) { return a; }\n");
    await writeFile(join(repo, "main.go"), "package main\nfunc fromGo() {}\n");
    await writeFile(join(repo, "mystery"), "def not_python():\n");
    const { result } = await runScope({ task: "anything", repo, noJev: true });
    const named = result.chunks.flatMap((s) => (s.chunk.name === undefined ? [] : [s.chunk.name]));
    expect(named.sort()).toEqual(["fromMjs", "fromNode", "from_py", "from_shebang"]);
    // Files with no analyzer (Go, an unrecognized text file) get text windows instead of being dropped.
    const windows = result.chunks.filter((s) => s.chunk.name === undefined).map((s) => s.chunk.file);
    expect(windows.sort()).toEqual(["main.go", "mystery"]);
    expect(result.chunks.find((s) => s.chunk.name === "fromNode")?.chunk.language).toBe("javascript");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
