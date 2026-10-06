import { afterEach, beforeEach, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { main, type Io } from "../src/main.ts";
import { FORMATS } from "../src/output/index.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const MIXED = join(ROOT, "fixtures/mixed-app");
const TASK = "Add retry handling to Stripe webhook processing";
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "docs/scope-result.schema.json"), "utf8")),
);

function capture(relevance?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    provider: relevance === undefined ? undefined : fakeProvider({ fallback: relevance }),
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(() => delete process.env.TYPESAFE_API_KEY);
afterEach(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
});

const minimumIn = (stderr: string) => Number(/--budget must be at least (\d+)/.exec(stderr)?.[1]);

/** The budget a failed run names, which must be the exact edge: it succeeds within itself and one token less fails. */
async function expectNamedMinimumIsExact(args: string[], relevance?: number) {
  const tiny = capture(relevance);
  expect(await main([...args, "--budget", "1"], tiny.io)).toBe(1);
  expect(tiny.stdout()).toBe("");
  const minimum = minimumIn(tiny.stderr());
  expect(minimum).toBeGreaterThan(1);

  const exact = capture(relevance);
  expect(await main([...args, "--budget", String(minimum)], exact.io)).toBe(0);
  expect(heuristicEstimator.count(exact.stdout())).toBeLessThanOrEqual(minimum);

  const below = capture(relevance);
  expect(await main([...args, "--budget", String(minimum - 1)], below.io)).toBe(1);
  expect(below.stdout()).toBe("");
  expect(minimumIn(below.stderr())).toBe(minimum);
}

for (const format of FORMATS) {
  test(`--format ${format}: a budget of 1, and one just below the named minimum, fail; the minimum itself works`, async () => {
    await expectNamedMinimumIsExact([TASK, "--repo", FIXTURE, "--no-jev", "--format", format]);
  });
}

for (const format of FORMATS) {
  test(`--format ${format}: nothing relevant is a successful empty artifact with a warning`, async () => {
    // Jev judges every candidate irrelevant, so nothing reaches the threshold.
    const run = capture(0.1);
    expect(await main([TASK, "--repo", FIXTURE, "--format", format], run.io)).toBe(0);
    expect(run.stderr()).toContain("scope: warning: No relevant chunks found");
    if (format === "json") {
      const parsed = JSON.parse(run.stdout());
      expect(validate(parsed)).toBe(true);
      expect(parsed.regions).toEqual([]);
      expect(parsed.skipped.length).toBeGreaterThan(0);
    } else {
      expect(run.stdout()).toContain(TASK);
      expect(run.stdout()).not.toContain("api/");
    }
  });
}

test("a task that matches no chunk succeeds with an empty artifact and retrieval's guidance, without Jev", async () => {
  const run = capture();
  expect(await main(["quuxfrobnicate", "--repo", MIXED, "--format", "json"], run.io)).toBe(0);
  expect(run.stderr()).toContain("No chunk matched the task");
  const parsed = JSON.parse(run.stdout());
  expect(validate(parsed)).toBe(true);
  expect(parsed.regions).toEqual([]);
});

test("a repository with no analyzable files yields an empty artifact", async () => {
  const repo = await mkdtemp(join(tmpdir(), "scope-empty-"));
  try {
    await writeFile(join(repo, "notes.bin"), Buffer.from([0, 1, 2, 3]));
    const run = capture();
    expect(await main([TASK, "--repo", repo, "--no-jev"], run.io)).toBe(0);
    expect(run.stderr()).toContain("No candidate chunks were found in the repository.");
    expect(run.stdout()).toContain("Scope context for:");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

for (const format of FORMATS) {
  test(`--format ${format}: a budget too small even for the empty artifact fails with an exact minimum`, async () => {
    const tiny = capture(0.1);
    await main([TASK, "--repo", FIXTURE, "--format", format, "--budget", "1"], tiny.io);
    expect(tiny.stderr()).toContain("cannot hold even an empty result");
    await expectNamedMinimumIsExact([TASK, "--repo", FIXTURE, "--format", format], 0.1);
  });
}
