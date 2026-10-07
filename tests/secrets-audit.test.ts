// The Jev API key must never reach output, logs, written files or tracked documents.
// There is no cache yet (M6, issue #68): when the cache directory exists it must join the audit below.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIConnectionError, APIError, APITimeoutError } from "@typesafe-ai/sdk";
import { main, type Io } from "../src/main.ts";
import { JevDecisionProvider, type JevClient } from "../src/jev/provider.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

// Captured at module load, before any test sets its own key.
const ORIGINAL_KEY = process.env.TYPESAFE_API_KEY?.trim();

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";
const FAKE_KEY = "tsk_audit_9f3a7c51d2e84b60a1c7e5d3b9f20481";

const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = FAKE_KEY;
});
afterEach(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
  else delete process.env.TYPESAFE_API_KEY;
});

function capture(provider: Io["provider"]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("a successful run never prints or writes the key, in any format, with or without --explain or --output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-audit-"));
  try {
    for (const format of ["text", "markdown", "json"]) {
      for (const explain of [[], ["--explain"]]) {
        const base = [TASK, "--repo", FIXTURE, "--format", format, ...explain];
        const toStdout = capture(fakeProvider());
        expect(await main(base, toStdout.io)).toBe(0);
        expect(toStdout.out().length).toBeGreaterThan(0);
        expect(toStdout.out()).not.toContain(FAKE_KEY);
        expect(toStdout.err()).not.toContain(FAKE_KEY);

        const file = join(dir, `out-${format}-${explain.length}`);
        const toFile = capture(fakeProvider());
        expect(await main([...base, "--output", file], toFile.io)).toBe(0);
        expect(toFile.out()).not.toContain(FAKE_KEY);
        expect(toFile.err()).not.toContain(FAKE_KEY);
        const written = await readFile(file, "utf8");
        expect(written.length).toBeGreaterThan(0);
        expect(written).not.toContain(FAKE_KEY);
      }
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("failures through the real provider never print the key", async () => {
  const leak = `Authorization: Bearer ${FAKE_KEY} x-api-key: ${FAKE_KEY}`;
  const headers = new Headers({ "x-api-key": FAKE_KEY, "x-typesafe-request-id": FAKE_KEY });
  const http = (status: number) =>
    Object.assign(APIError.fromResponse(status, { detail: leak, echoed: FAKE_KEY }, headers), {
      cause: new Error(leak),
    });
  const errors: unknown[] = [
    ...[400, 401, 403, 429, 500].map(http),
    new APIConnectionError(leak),
    new APITimeoutError(1),
    new Error(leak),
  ];
  for (const sdkError of errors) {
    const client: JevClient = {
      async systemOne() {
        throw sdkError;
      },
    };
    const run = capture(new JevDecisionProvider({ client }));
    const code = await main([TASK, "--repo", FIXTURE, "--format", "json"], run.io);
    expect(code).toBeGreaterThanOrEqual(3);
    expect(run.out()).toBe("");
    expect(run.err().length).toBeGreaterThan(0);
    expect(run.err()).not.toContain(FAKE_KEY);
  }
});

const AUDITED = ["docs", "tasks", "fixtures", "tests/golden", "README.md"];
const tracked = (): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", ...AUDITED], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");

// A value assigned to the key variable that is not an obvious placeholder.
const ASSIGNMENT = /TYPESAFE_API_KEY\s*=\s*["']?(?!\.\.\.|\$|<|your)[A-Za-z0-9_-]{12,}/i;

test("no tracked doc, task, fixture or golden file assigns a real-looking value to TYPESAFE_API_KEY", () => {
  const files = tracked();
  expect(files.length).toBeGreaterThan(0);
  const found = files.filter((file) => ASSIGNMENT.test(readFileSync(join(ROOT, file), "utf8")));
  expect(found).toEqual([]);
});

test("the pattern flags a real-looking assignment and accepts placeholders", () => {
  expect(ASSIGNMENT.test('TYPESAFE_API_KEY="abcdefghijklmnop1234"')).toBe(true);
  expect(ASSIGNMENT.test("TYPESAFE_API_KEY=abcdefghijklmnop1234")).toBe(true);
  expect(ASSIGNMENT.test("TYPESAFE_API_KEY=...")).toBe(false);
  expect(ASSIGNMENT.test("TYPESAFE_API_KEY=$KEY")).toBe(false);
  expect(ASSIGNMENT.test("TYPESAFE_API_KEY=<your key>")).toBe(false);
});

test("the real key from the environment, when set, appears in no tracked file", () => {
  if (!ORIGINAL_KEY) return;
  const all = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");
  const found = all.filter((file) => {
    try {
      return readFileSync(join(ROOT, file), "utf8").includes(ORIGINAL_KEY);
    } catch {
      return false;
    }
  });
  expect(found).toEqual([]);
});
