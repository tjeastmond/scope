import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTypeScriptChunks, TYPESCRIPT_EXTENSIONS } from "../src/analyzers/typescript.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import { listFiles } from "../src/repository/files.ts";
import type { CodeChunk } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/webhook-service");

async function extractFixture(): Promise<CodeChunk[]> {
  const files = await listFiles(FIXTURE, TYPESCRIPT_EXTENSIONS);
  const perFile = await Promise.all(
    files.map(async (file) =>
      extractTypeScriptChunks(file, await readFile(join(FIXTURE, file), "utf8"), charsPerTokenEstimator),
    ),
  );
  return perFile.flat();
}

const inventory = (chunks: CodeChunk[]) =>
  chunks.map((c) => `${c.file}#${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

test("extracts the expected chunk inventory from the fixture", async () => {
  expect(inventory(await extractFixture())).toEqual([
    "src/dates/utils.ts#function:format@1-3",
    "src/dates/utils.ts#function:addDays@5-9",
    "src/email/format.ts#function:format@1-3",
    "src/email/sender.ts#function:sendWithRetry@4-16",
    "src/email/sender.ts#function:deliver@18-26",
    "src/logger.ts#class:Logger@1-15",
    "src/logger.ts#method:Logger.info@4-6",
    "src/logger.ts#method:Logger.warn@8-10",
    "src/logger.ts#method:Logger.error@12-14",
    "src/stripe/handler.ts#function:handleStripeWebhook@7-25",
    "src/stripe/handler.ts#function:processEvent@27-38",
    "src/stripe/handler.ts#function:markInvoicePaid@40-45",
    "src/stripe/handler.ts#function:cancelSubscription@47-52",
    "src/stripe/types.ts#interface:StripeEvent@1-6",
    "src/stripe/types.ts#type:WebhookResult@8-8",
    "src/users/profile.ts#interface:UserProfile@3-7",
    "src/users/profile.ts#function:renderProfile@9-11",
    "src/util/retry.ts#interface:RetryOptions@1-5",
    "src/util/retry.ts#function:computeBackoff@7-11",
    "src/util/retry.ts#function:withRetry@13-26",
    "src/webhooks/signature.ts#interface:ParsedSignature@1-4",
    "src/webhooks/signature.ts#function:parseSignatureHeader@8-13",
    "src/webhooks/signature.ts#function:verifySignature@15-23",
    "src/webhooks/signature.ts#function:sign@25-31",
    "tests/handler.test.ts#function:expectStatus@3-7",
    "tests/handler.test.ts#function:checkRejectsInvalidSignature@9-12",
  ]);
});

test("chunk content is the exact source lines and IDs are stable and unique", async () => {
  const [first, second] = [await extractFixture(), await extractFixture()];
  expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
  for (const chunk of first) {
    const lines = (await readFile(join(FIXTURE, chunk.file), "utf8")).split("\n");
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunk.estimatedTokens).toBe(charsPerTokenEstimator.count(chunk.content));
  }
});

test("extracts exported arrow-function constants and ignores plain values", async () => {
  const source = "export const a = (x: number) => x;\nconst n = 3;\nexport default class {}\n";
  const chunks = await extractTypeScriptChunks("x.ts", source, charsPerTokenEstimator);
  expect(inventory(chunks)).toEqual(["x.ts#function:a@1-1"]);
});

const built = existsSync(join(import.meta.dir, "../dist/analyzers/typescript.js"));
test.skipIf(!built)(
  "works from the compiled dist/ under Node, including concurrent first use of both grammars",
  async () => {
    const script = `
    import { extractTypeScriptChunks } from "./dist/analyzers/typescript.js";
    const est = { id: "t", count: (s) => s.length };
    // Concurrent first use of both grammars in a fresh process.
    const results = await Promise.all(
      ["a.ts", "b.tsx"].map((file) => extractTypeScriptChunks(file, "export function f() {}\\n", est)),
    );
    console.log(JSON.stringify(results.flat().map((c) => c.name)));
  `;
    const proc = Bun.spawn(["node", "--input-type=module", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe('["f","f"]\n');
    expect(await proc.exited).toBe(0);
  },
);

test("gives a getter and setter on one line distinct names and IDs", async () => {
  const chunks = await extractTypeScriptChunks(
    "a.ts",
    "class C { get x() { return 1; } set x(v: number) {} }",
    charsPerTokenEstimator,
  );
  const accessors = chunks.filter((chunk) => chunk.kind === "method");
  expect(accessors.map((chunk) => chunk.name)).toEqual(["C.get x", "C.set x"]);
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
});
