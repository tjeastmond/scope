import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevRequestError, JevResponseError, JevUnavailableError } from "../src/jev/errors.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { main, type Io } from "../src/main.ts";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import type { DecisionProvider } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "docs/scope-result.schema.json"), "utf8")),
);
const TASK = "Add retry handling to Stripe webhook processing";

function capture(provider?: DecisionProvider) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const retryProvider = fakeProvider({
  relevance: { withRetry: 0.9, computeBackoff: 0.9, sendWithRetry: 0.9, RetryOptions: 0.9 },
});

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
  const run = capture(retryProvider);
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(0);
  expect(run.stdout()).toContain("withRetry");
  expect(run.stdout()).toContain("computeBackoff");
  expect(run.stdout()).not.toContain("renderProfile");
  expect(run.stderr()).toContain("Jev 3ms, 5 input / 1 output tokens");
});

test("the default path without a key fails with guidance and prints nothing to stdout", async () => {
  const run = capture();
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(3);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toMatch(/TYPESAFE_API_KEY is not set[\s\S]*--no-jev/);
});

test("an incomplete provider response fails instead of becoming offline-style results", async () => {
  const run = capture({ decide: async () => ({ judgments: [], usage: {}, latencyMs: 1 }) });
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(7);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toContain("Missing judgments");
});

test("ignored and secret-looking files never reach the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-cli-"));
  try {
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "private/\n");
    await writeFile(join(root, "ok.ts"), "export function ok() {}\n");
    await writeFile(join(root, "client.ts"), 'export function client() { return "AKIAABCDEFGHIJKLMNOP"; }\n');
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
    expect(seen.join("\n")).toContain("[REDACTED]");
    expect(seen.join("\n")).not.toMatch(/hiddenIgnored|hiddenSecret|hiddenBinary|AKIAABCDEFGHIJKLMNOP/);
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

const KEY = "tsk-test-key-1234567890";
const failing = (error: Error): DecisionProvider => ({
  decide: async () => {
    throw error;
  },
});

test.each([
  [new JevUnavailableError("Jev request failed (HTTP 429, rate limited; try again later)."), "Jev unavailable:", 6],
  [new JevResponseError("Missing judgments for 3 candidate(s)."), "Jev returned an unusable response:", 7],
  [new JevRequestError("big.ts:1 with the task is too large."), "Jev request not sent:", 8],
])("%s exits with a distinct label, its own exit code, empty stdout, and never the key", async (error, label, code) => {
  process.env.TYPESAFE_API_KEY = KEY;
  const run = capture(failing(error));
  expect(await main([TASK, "--repo", FIXTURE], run.io)).toBe(code);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toContain(label);
  expect(run.stderr()).not.toContain(KEY);
});

const EMPTY = 'The task description is empty. Pass it in quotes: scope "<task>"';
const FORMAT = "--format must be one of text, markdown, json";
const NOT_DIR = `${FIXTURE}.TASK.md`;
test.each([
  [[""], EMPTY],
  [["   "], EMPTY],
  [[TASK, "--format", "xml"], `${FORMAT}: got "xml"`],
  [[TASK, "--format", ""], `${FORMAT}: got ""`],
  [[TASK, "--repo", ""], "--repo requires a path"],
  [[TASK, "--repo", "/nonexistent/dir"], "--repo does not exist or is not accessible: /nonexistent/dir"],
  [[TASK, "--repo", NOT_DIR], `--repo is not a directory: ${NOT_DIR}`],
  [[TASK, "--output", ""], "--output requires a path"],
  [["a", "b"], 'Expected exactly one task description, in quotes: scope "<task>"'],
])("usage error %j exits 2 with an exact message and no stdout", async (argv, message) => {
  const run = capture();
  expect(await main(argv, run.io)).toBe(2);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toBe(`scope: ${message}\n`);
});

test("an unknown flag exits 2 on stderr", async () => {
  const run = capture();
  expect(await main([TASK, "--bogus"], run.io)).toBe(2);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toStartWith("scope: ");
});

test("--help documents every flag with its default", async () => {
  const run = capture();
  expect(await main(["--help"], run.io)).toBe(0);
  const help = run.stdout();
  for (const flag of ["--repo", "--format", "--output", "--explain", "--no-jev", "--help"])
    expect(help).toContain(flag);
  expect(help).toContain("(default: current directory)");
  expect(help).not.toContain("--budget");
  expect(help).toContain("(default: text)");
  expect(help).toContain("(default: stdout)");
  expect(help).toContain("(default: off)");
  expect(help).not.toContain("Not yet implemented");
  expect(help).not.toContain("--format, --output");
});

test.each([
  ["text", "-- Explanation --"],
  ["markdown", "## Explanation"],
  ["json", '"explain": true'],
])("--explain adds the evidence to %s output and its absence leaves it out", async (format, marker) => {
  const explained = capture();
  expect(await main([TASK, "--repo", FIXTURE, "--no-jev", "--format", format, "--explain"], explained.io)).toBe(0);
  expect(explained.stdout()).toContain(marker);
  const plain = capture();
  expect(await main([TASK, "--repo", FIXTURE, "--no-jev", "--format", format], plain.io)).toBe(0);
  expect(plain.stdout()).not.toContain(marker);
});

test("--format json prints only parseable, schema-valid JSON on stdout; warnings stay on stderr", async () => {
  const run = capture(retryProvider);
  expect(await main([TASK, "--repo", FIXTURE, "--format", "json"], run.io)).toBe(0);
  const payload = JSON.parse(run.stdout());
  expect(validate(payload)).toBe(true);
  expect(payload.mode).toBe("jev");
  expect(run.stdout()).toEndWith("}\n");
  expect(run.stderr()).toContain("Jev 3ms");
  expect(run.stdout()).not.toContain("scope: ");
});

test("--format markdown starts with the heading and keeps stderr output off stdout", async () => {
  const run = capture(retryProvider);
  expect(await main([TASK, "--repo", FIXTURE, "--format", "markdown"], run.io)).toBe(0);
  expect(run.stdout()).toStartWith("# Scope context\n");
  expect(run.stdout()).toContain("withRetry");
  expect(run.stdout()).not.toContain("Jev 3ms");
});

test("--format text is the default output", async () => {
  const base = capture();
  const text = capture();
  await main([TASK, "--repo", FIXTURE, "--no-jev"], base.io);
  expect(await main([TASK, "--repo", FIXTURE, "--no-jev", "--format", "text"], text.io)).toBe(0);
  expect(text.stdout()).toBe(base.stdout());
  expect(text.stdout()).toStartWith("Scope context for: ");
});

test("warnings go to stderr, never stdout, in every format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-warn-"));
  try {
    // A file that only partly parses makes the analyzer emit a warning.
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export function retry() { return 1 }\nexport function broken( {\n");
    for (const format of ["text", "markdown", "json"]) {
      const run = capture();
      expect(await main(["retry", "--repo", dir, "--no-jev", "--format", format], run.io)).toBe(0);
      expect(run.stderr()).toContain("scope: warning: ");
      expect(run.stdout()).not.toContain("scope: warning");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no arguments prints help", async () => {
  const run = capture();
  expect(await main([], run.io)).toBe(0);
  expect(run.stdout()).toContain("Usage: scope");
});

test.each([[[TASK, "--budget", "700"]], [[TASK, "--budget=700"]], [[TASK, "--budget", "abc"]]])(
  "--budget is removed: %j is a usage error that says so",
  async (argv) => {
    const run = capture();
    expect(await main([...argv, "--repo", FIXTURE, "--no-jev"], run.io)).toBe(2);
    expect(run.stdout()).toBe("");
    expect(run.stderr()).toBe(
      "scope: Unknown option '--budget'. Scope has no token budget: it returns everything relevant to the task.\n",
    );
  },
);

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
  expect(online.code).toBe(3);
  expect(online.stdout).toBe("");
  expect(online.stderr).toContain("TYPESAFE_API_KEY");
});
