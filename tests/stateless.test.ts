import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.ts";
import type { DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scope-stateless-"));
  await cp(FIXTURE, dir, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Every path under `root` with its size and mtime, so any write, even a rewrite with equal content, shows. */
async function snapshot(root: string, rel = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, entry.name);
    const info = await stat(join(root, path));
    entries.push(`${path} ${info.size} ${info.mtimeMs}`);
    if (entry.isDirectory()) entries.push(...(await snapshot(root, path)));
  }
  return entries.sort();
}

async function run(argv: string[], provider?: DecisionProvider) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  const code = await main(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test.each([
  ["a default run with a provider", fakeProvider({ fallback: 0.9 }), []],
  ["a --no-jev run", undefined, ["--no-jev"]],
])("%s creates no .scope directory and leaves the repository unchanged", async (_name, provider, flags) => {
  const before = await snapshot(dir);
  const result = await run([TASK, "--repo", dir, ...flags], provider);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toBe("");
  expect(await snapshot(dir)).toEqual(before);
  expect(await readdir(dir)).not.toContain(".scope");
});

test.each([["--no-cache"], ["--fresh"]])("%s is an unknown option (exit 2)", async (flag) => {
  const result = await run([TASK, flag, "--repo", dir, "--no-jev"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Unknown option '${flag}'`);
  expect(result.stderr).toContain("Run scope --help for the options.");
});

test.each([["cache"], ["feedback"]])("a task named %s is just a task", async (word) => {
  const result = await run([word, "--repo", dir, "--no-jev"]);
  expect(result.code).toBe(0);
});
