import { expect, test } from "bun:test";
import { join } from "node:path";
import { CancelledError, RetrievalConfigError, UsageError } from "../src/errors.ts";
import { EXIT_CODES, exitCodeFor } from "../src/exit-codes.ts";
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
import type { DecisionProvider } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";

const cases: [string, Error, number, string][] = [
  ["JevAuthError", new JevAuthError("TYPESAFE_API_KEY is not set."), 3, "Jev unavailable:"],
  ["JevRateLimitError", new JevRateLimitError("rate limited"), 4, "Jev unavailable:"],
  // The 30 s attempt timeout and 90 s deadline make a real timeout too slow for a subprocess test, and shipped code has
  // no override for them; the subprocess suite covers every other class, this fake-provider run covers exit 5.
  ["JevTimeoutError", new JevTimeoutError("too slow"), 5, "Jev unavailable:"],
  ["JevServiceError", new JevServiceError("down"), 6, "Jev unavailable:"],
  ["JevUnavailableError", new JevUnavailableError("other"), 6, "Jev unavailable:"],
  ["JevResponseError", new JevResponseError("bad answer"), 7, "Jev returned an unusable response:"],
  ["JevRequestError", new JevRequestError("too large"), 8, "Jev request not sent:"],
];

test("every error class maps to its documented exit code", () => {
  for (const [, error, code] of cases) expect(exitCodeFor(error)).toBe(code);
  expect(exitCodeFor(new UsageError("x"))).toBe(2);
  expect(exitCodeFor(new CancelledError())).toBe(130);
  expect(exitCodeFor(new JevCancelledError("x"))).toBe(130);
  expect(exitCodeFor(new JevError("x"))).toBe(1);
  expect(exitCodeFor(new RetrievalConfigError("f", "r"))).toBe(1);
  expect(exitCodeFor(new Error("x"))).toBe(1);
  expect(exitCodeFor("not an error")).toBe(1);
});

test("the exit codes are distinct and frozen", () => {
  const codes = Object.values(EXIT_CODES);
  expect(new Set(codes).size).toBe(codes.length);
  expect(Object.isFrozen(EXIT_CODES)).toBe(true);
});

async function run(error: Error) {
  const out: string[] = [];
  const err: string[] = [];
  const provider: DecisionProvider = {
    decide: async () => {
      throw error;
    },
  };
  const code = await main([TASK, "--repo", FIXTURE], {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    provider,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

for (const [name, error, code, label] of cases) {
  test(`${name} through main: exit ${code}, empty stdout, a label line and a guidance line naming --no-jev`, async () => {
    const result = await run(error);
    expect(result.code).toBe(code);
    expect(result.stdout).toBe("");
    const lines = result.stderr.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`scope: ${label} ${error.message}`);
    expect(lines[1]).toMatch(/^scope: .*--no-jev/);
  });
}

test("a cancellation through main exits 130 with a Cancelled line and no guidance", async () => {
  const result = await run(new JevCancelledError("Jev request cancelled."));
  expect(result.code).toBe(130);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("scope: Cancelled: Jev request cancelled.\n");
});
