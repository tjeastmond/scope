// Cold versus warm equivalence and robustness of the persistent cache (#81): the cache never makes Scope wrong.
//
// The core assertion everywhere: a warm run (cache on, `.scope/` populated) equals a cold run (`--no-cache` on the
// same tree, or in-process with the cache off) once the parts that legitimately differ are normalized away: the
// `cache` report (`cold` and the file counts), run ids and times. "Equals" covers the source inventory (every chunk
// id, file, range, kind, name, content and reference) and the full `--no-jev` JSON output.
//
// Already proven elsewhere, so not repeated here:
//
//   | Matrix item                         | Where                                                                    |
//   | ----------------------------------- | ------------------------------------------------------------------------ |
//   | parse counting, reuse by stat/hash  | tests/cache-invalidation.test.ts, tests/incremental-refresh.test.ts      |
//   | parser/grammar/analyzer version key | tests/cache-invalidation.test.ts "each version key invalidates ..."      |
//   | ignore rules, deleted store         | tests/cache-invalidation.test.ts                                         |
//   | corrupt shard/files/meta, tmp files | tests/cache-invalidation.test.ts "corruption and partial writes ..."      |
//   | store-level interrupted write       | tests/cache-store.test.ts (partial .tmp, stale and fresh locks)          |
//   | store-level concurrent commits      | tests/cache-store.test.ts (several processes, tests/helpers/store-*.ts)   |
//   | status/clear/rebuild mechanics      | tests/cache-controls.test.ts                                             |
//   | each corrupt document is a miss     | cache-history / cache-decisions / cache-feedback / cache-weights tests   |
//
// What is added here is the end-to-end view: output equality through the CLI, branch switches with real git,
// processes killed mid-run, concurrent CLI processes, planted stores, and clearing followed by a run.
//
// The CLI-process tests run the built CLI (`dist/`) under `SCOPE_NODE` (default: `node` from PATH), so the same
// suite exercises a chosen Node. `bun run test:node-matrix` runs it once for each Node in `SCOPE_NODES`
// (colon-separated), for example the Node 24 and 26 installs. Every spawned process has a timeout and is reaped in
// `finally`; a test kills only a child it spawned, through that child's own handle.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheStatus } from "../src/cache/controls.ts";
import { submitFeedback } from "../src/feedback.ts";
import { main, type Io } from "../src/main.ts";
import { renderFormat } from "../src/output/index.ts";
import { runScope, loadChunks } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "fixtures");
const CLI = join(ROOT, "dist/cli.js");
const NODE = process.env.SCOPE_NODE ?? "node";

const WEBHOOK_TASK = "Add retry handling to Stripe webhook processing";
const WEBHOOK_TASK_2 = "Verify the webhook signature before parsing the payload";
// Spans TypeScript, Python, SQL, TOML and Markdown so the lexical pre-filter keeps chunks from each.
const MIXED_TASK =
  "Show each invoice due date in the invoice list, query it in SQL, and make the reminder worker retry attempts " +
  "configurable from config/app.toml, then document it.";
const TASKS: Record<string, string> = { "webhook-service": WEBHOOK_TASK, "mixed-app": MIXED_TASK };

const SPAWN_TIMEOUT_MS = 30_000;
const POLL_CAP_MS = 15_000;
const HOUR = 3_600_000;

let tmp: string;
let stateHome: string;
const savedCache = process.env.SCOPE_CACHE;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedState = process.env.XDG_STATE_HOME;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    const build = spawnSync("bun", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    if (build.status !== 0) throw new Error(`bun run build failed:\n${build.stdout}${build.stderr}`);
  }
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scope-robust-"));
  stateHome = await mkdtemp(join(tmpdir(), "scope-robust-state-"));
  // In-process runs use the cache unless a call passes --no-cache; the integrity key goes to a temporary state home.
  delete process.env.SCOPE_CACHE;
  delete process.env.TYPESAFE_API_KEY;
  process.env.XDG_STATE_HOME = stateHome;
});
afterEach(async () => {
  if (savedCache === undefined) delete process.env.SCOPE_CACHE;
  else process.env.SCOPE_CACHE = savedCache;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  await rm(tmp, { recursive: true, force: true });
  await rm(stateHome, { recursive: true, force: true });
});
afterAll(() => {
  process.env.SCOPE_CACHE = "off";
});

// ---------------------------------------------------------------------------------------------------- helpers

async function copyFixture(name: string, as = name): Promise<string> {
  const repo = join(tmp, as);
  await cp(join(FIXTURES, name), repo, { recursive: true });
  return repo;
}

const storeDir = (repo: string) => join(repo, ".scope/store-v1");
const later = () => Date.now() + HOUR;

/** The comparable view of a chunk: everything the cache could get wrong. */
const fingerprint = (chunk: CodeChunk) => ({
  id: chunk.id,
  file: chunk.file,
  language: chunk.language,
  kind: chunk.kind,
  name: chunk.name,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  parentId: chunk.parentId,
  containerName: chunk.containerName,
  references: chunk.references,
  content: createHash("sha256").update(chunk.content).digest("hex"),
});

/** Source inventory of a tree, with the analysis cache off (cold) or on (warm). */
async function inventory(repo: string, cached: boolean) {
  const { chunks, warnings, files } = await loadChunks(repo, cached ? { cache: { now: later } } : {});
  return { files, warnings, chunks: chunks.map(fingerprint) };
}

/** Warm inventory equals the cold one; the first call may populate the cache. */
async function expectInventoryEquivalent(repo: string) {
  const warm = await inventory(repo, true);
  expect(warm).toEqual(await inventory(repo, false));
  return warm;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

/** Runs the CLI in process. */
async function cli(...argv: string[]) {
  const run = capture();
  const code = await main(argv, run.io);
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

type Json = Record<string, unknown> & { cache?: CacheJson };
interface CacheJson {
  cold: boolean;
  files: { reused: number; refreshed: number; removed: number; refreshedPaths: string[] };
}

/**
 * A message about the cache itself ("cache busy; ...", "history-x.json: not valid JSON ..."): cache problems are
 * warnings that never change the result, so they are the one thing allowed to differ between a cold and a warm run.
 */
const isCacheWarning = (warning: unknown) => typeof warning === "string" && /^cache |^[\w.-]+\.json: /.test(warning);

/** Drops what legitimately differs between a cold and a warm run: the cache report, run ids, times, cache warnings. */
function normalize(json: Json): Omit<Json, "cache"> {
  const rest: Json = { ...json };
  delete rest.cache;
  const plain = JSON.parse(
    JSON.stringify(rest, (key, value) => (key === "runId" || key === "latencyMs" ? undefined : value)),
  );
  if (Array.isArray(plain.warnings))
    plain.warnings = plain.warnings.filter((warning: unknown) => !isCacheWarning(warning));
  return plain;
}

/** Everything but the task text, for "this name appears nowhere in the result". */
const body = (json: Json) => JSON.stringify({ ...json, task: undefined });

/** A `--no-jev` run in process. `cached: false` is the cold reference (`--no-cache`). */
async function taskRun(repo: string, task: string, cached: boolean): Promise<Json> {
  const run = await cli(task, "--repo", repo, "--no-jev", "--format", "json", ...(cached ? [] : ["--no-cache"]));
  expect(run.code).toBe(0);
  return JSON.parse(run.stdout) as Json;
}

/** Warm output equals cold output on this tree. Returns the warm run so the caller can inspect its cache report. */
async function expectOutputEquivalent(repo: string, task: string): Promise<Json> {
  const warm = await taskRun(repo, task, true);
  const cold = await taskRun(repo, task, false);
  expect(cold.cache).toBeUndefined();
  expect(normalize(warm)).toEqual(normalize(cold));
  return warm;
}

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

/** Every file under a directory with a digest of its bytes, for "this store did not change" comparisons. */
async function digestTree(directory: string, prefix = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, await digestTree(join(directory, entry.name), `${path}/`));
    else
      found[path] = createHash("sha256")
        .update(await readFile(join(directory, entry.name)))
        .digest("hex");
  }
  return found;
}

// ----------------------------------------------------------------------------------------- CLI subprocesses

interface Spawned {
  child: ChildProcess;
  /** Resolves when the child exits; rejects (after killing it through its own handle) past the timeout. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number }>;
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: stateHome, ...extra };
  delete env.SCOPE_CACHE;
  delete env.TYPESAFE_API_KEY;
  return env;
}

/** Starts the Node under test with `args`. The caller reaps it: `await spawned.done` or `reap`. */
function spawnNode(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Spawned {
  const argv = args;
  const started = Date.now();
  const child = spawn(NODE, args, { cwd: ROOT, env: childEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
  const done = new Promise<Awaited<Spawned["done"]>>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`node did not exit within ${SPAWN_TIMEOUT_MS} ms: ${argv.join(" ").slice(0, 200)}`));
    }, SPAWN_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
  // A rejection nobody awaits (a test that failed first) must not become an unhandled rejection.
  done.catch(() => undefined);
  return { child, done };
}

/** Starts the built CLI under `SCOPE_NODE`. */
const spawnCli = (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnNode([CLI, ...argv], extraEnv);

/** Kills a child this test spawned (a no-op once it exited) and waits for it, so no process outlives its test. */
async function reap(spawned: Spawned): Promise<void> {
  if (spawned.child.exitCode === null && spawned.child.signalCode === null) spawned.child.kill("SIGKILL");
  await spawned.done.catch(() => undefined);
}

const taskArgv = (repo: string, task: string, ...extra: string[]) => [
  task,
  "--repo",
  repo,
  "--no-jev",
  "--format",
  "json",
  ...extra,
];

/** Runs the CLI to completion and parses its JSON; always reaped. */
async function runChild(repo: string, task: string, ...extra: string[]) {
  const spawned = spawnCli(taskArgv(repo, task, ...extra));
  try {
    const result = await spawned.done;
    return { ...result, json: result.code === 0 ? (JSON.parse(result.stdout) as Json) : undefined };
  } finally {
    await reap(spawned);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------ the Node under test

describe("the Node under test", () => {
  test("is Node 24 or newer", () => {
    const version = spawnSync(NODE, ["--version"], { encoding: "utf8", timeout: 10_000 });
    expect(version.status).toBe(0);
    const major = Number(/^v(\d+)\./.exec(version.stdout)?.[1]);
    expect(major).toBeGreaterThanOrEqual(24);
  });
});

// -------------------------------------------------------------------- 1. cold/warm equivalence on every fixture

describe("cold and warm runs agree on every fixture", () => {
  for (const name of ["webhook-service", "mixed-app"]) {
    test(`${name}: source inventory and --no-jev output`, async () => {
      const repo = await copyFixture(name);
      const populated = await expectInventoryEquivalent(repo);
      expect(populated.chunks.length).toBeGreaterThan(5);
      const second = await expectInventoryEquivalent(repo);
      expect(second).toEqual(populated);

      const first = await taskRun(repo, TASKS[name]!, true);
      expect(first.cache?.files.refreshed).toBe(0); // the inventory runs above already populated the cache
      const warm = await expectOutputEquivalent(repo, TASKS[name]!);
      expect(warm.cache?.cold).toBe(false);
      expect(warm.cache?.files).toMatchObject({ refreshed: 0, removed: 0 });
      expect(warm.cache!.files.reused).toBeGreaterThan(0);
    });
  }

  test("through the built CLI under the selected Node, cold, then warm, equal an uncached run", async () => {
    const repo = await copyFixture("webhook-service");
    const cold = await runChild(repo, WEBHOOK_TASK, "--no-cache");
    const first = await runChild(repo, WEBHOOK_TASK);
    const warm = await runChild(repo, WEBHOOK_TASK);
    for (const run of [cold, first, warm]) expect(run.code).toBe(0);
    expect(cold.json!.cache).toBeUndefined();
    expect(first.json!.cache?.cold).toBe(true);
    expect(warm.json!.cache).toMatchObject({ cold: false, files: { refreshed: 0, removed: 0 } });
    expect(warm.json!.cache!.files.reused).toBe(first.json!.cache!.files.refreshed);
    expect(normalize(first.json!)).toEqual(normalize(cold.json!));
    expect(normalize(warm.json!)).toEqual(normalize(cold.json!));
  });
});

// ------------------------------------------------------------------------------ 2. edit, rename and delete

const QUOKKA = "quokkaReconcile";
const QUOKKA_TASK = `${WEBHOOK_TASK} with ${QUOKKA}`;
const QUOKKA_FILE = "src/billing/reconcile.ts";
const QUOKKA_SOURCE = `export function ${QUOKKA}(total: number): number {\n  return total + 1;\n}\n`;

describe("edit, rename and delete", () => {
  test("each change makes the warm run equal the cold run, and deleted code is gone everywhere", async () => {
    const repo = await copyFixture("webhook-service");
    await mkdir(join(repo, "src/billing"), { recursive: true });
    await writeFile(join(repo, QUOKKA_FILE), QUOKKA_SOURCE);

    // Control: the planted function is part of the inventory and of the output, and a warm run has seen it.
    await expectInventoryEquivalent(repo);
    const before = await expectOutputEquivalent(repo, QUOKKA_TASK);
    expect(body(before)).toContain(QUOKKA);

    // Edit: rename a function in a cached file.
    const retry = join(repo, "src/util/retry.ts");
    await writeFile(retry, (await readFile(retry, "utf8")).replaceAll("computeBackoff", "computeBackoffV2"));
    const afterEdit = await expectOutputEquivalent(repo, QUOKKA_TASK);
    expect(afterEdit.cache?.files.refreshed).toBe(1);
    expect(body(afterEdit)).not.toContain('"computeBackoff"');
    const edited = await expectInventoryEquivalent(repo);
    expect(edited.chunks.some((chunk) => chunk.name === "computeBackoffV2")).toBe(true);
    expect(edited.chunks.some((chunk) => chunk.name === "computeBackoff")).toBe(false);

    // Rename: the same bytes at a new path.
    await mkdir(join(repo, "src/lib"), { recursive: true });
    await rename(join(repo, "src/logger.ts"), join(repo, "src/lib/logger.ts"));
    const afterRename = await expectOutputEquivalent(repo, QUOKKA_TASK);
    expect(body(afterRename)).not.toContain('"src/logger.ts"');
    const renamed = await expectInventoryEquivalent(repo);
    expect(renamed.chunks.some((chunk) => chunk.file === "src/logger.ts")).toBe(false);
    expect(renamed.chunks.some((chunk) => chunk.file === "src/lib/logger.ts")).toBe(true);

    // Delete: the planted file disappears from the inventory, the output and the store.
    await rm(join(repo, QUOKKA_FILE));
    const afterDelete = await taskRun(repo, QUOKKA_TASK, true);
    expect(afterDelete.cache?.files.removed).toBe(1);
    expect(normalize(afterDelete)).toEqual(normalize(await taskRun(repo, QUOKKA_TASK, false)));
    expect(body(afterDelete)).not.toContain(QUOKKA);
    const deleted = await expectInventoryEquivalent(repo);
    expect(JSON.stringify(deleted)).not.toContain(QUOKKA);
    for (const name of await readdir(storeDir(repo))) {
      expect(await readFile(join(storeDir(repo), name), "utf8")).not.toContain(QUOKKA_FILE);
    }
  });

  test("deleted code is not offered by memory or a reused decision on the next Jev run", async () => {
    const repo = await copyFixture("webhook-service");
    await mkdir(join(repo, "src/billing"), { recursive: true });
    await writeFile(join(repo, QUOKKA_FILE), QUOKKA_SOURCE);
    let clock = Date.now();
    const now = () => (clock += 1000);
    const calls: string[][] = [];
    const inner = fakeProvider({ relevance: { [QUOKKA]: 0.9, withRetry: 0.9 }, fallback: 0.05 });
    const provider: DecisionProvider = {
      decisionCacheKey: inner.decisionCacheKey,
      async decide(input) {
        calls.push(input.candidates.map((chunk) => chunk.name ?? ""));
        return inner.decide(input);
      },
    };
    const jevRun = async (task: string, cache: boolean) => {
      const { result } = await runScope({ task, repo, provider, cache, cacheOptions: { now, env: {} } });
      return JSON.parse(renderFormat("json", result)) as Json;
    };

    await jevRun(QUOKKA_TASK, true); // records history and decisions mentioning the planted function
    // A similar task that does not name it: memory brings it back while the file exists (the control).
    const similar = `${WEBHOOK_TASK} reconcile`;
    const withFile = await jevRun(similar, true);
    expect(body(withFile)).toContain(QUOKKA);

    await rm(join(repo, QUOKKA_FILE));
    calls.length = 0;
    const warm = await jevRun(similar, true);
    const warmSame = await jevRun(QUOKKA_TASK, true);
    expect(body(warm)).not.toContain(QUOKKA);
    expect(body(warmSame)).not.toContain(QUOKKA);
    expect(calls.flat()).not.toContain(QUOKKA);
    // And the deletion left the same answer as a run that never had a cache.
    const cold = await jevRun(similar, false);
    expect(body(cold)).not.toContain(QUOKKA);
    expect(normalize(warm).regions).toEqual(normalize(cold).regions);
  });
});

// ------------------------------------------------------------------------------------------ 3. branch switch

describe("branch switches with real git", () => {
  const git = (repo: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Scope Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, encoding: "utf8", timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );

  test("main, branch, main, branch: the warm run equals the cold run after every checkout", async () => {
    const repo = await copyFixture("mixed-app");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main");

    git(repo, "checkout", "-q", "-b", "feature");
    const edits = ["api/src/routes/invoices.ts", "worker/tasks.py", "api/src/models/invoice.ts"];
    for (const path of edits) {
      const comment = path.endsWith(".py") ? "#" : "//";
      await writeFile(join(repo, path), `${await readFile(join(repo, path), "utf8")}\n${comment} on feature\n`);
    }
    await mkdir(join(repo, "worker/lib"), { recursive: true });
    git(repo, "mv", "worker/format.py", "worker/lib/render_output.py");
    const deletedName = "names"; // worker/names.py
    const deletedSource = await readFile(join(repo, "worker/names.py"), "utf8");
    git(repo, "rm", "-q", "worker/names.py", "api/src/routes/health.ts");
    await writeFile(join(repo, "api/src/added.ts"), "export function addedOnFeature() {\n  return 1;\n}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "main");

    const deletedSymbol = /^def (\w+)/m.exec(deletedSource)?.[1];
    expect(deletedSymbol).toBeDefined();

    const onMain = await expectInventoryEquivalent(repo);
    expect(onMain.chunks.some((chunk) => chunk.file === `worker/${deletedName}.py`)).toBe(true);
    await expectOutputEquivalent(repo, MIXED_TASK);

    for (const branch of ["feature", "main", "feature", "main"]) {
      git(repo, "checkout", "-q", branch);
      const inv = await expectInventoryEquivalent(repo);
      const warm = await expectOutputEquivalent(repo, MIXED_TASK);
      expect(warm.cache?.cold).toBe(false);
      const onFeature = branch === "feature";
      expect(inv.chunks.some((chunk) => chunk.file === "worker/names.py")).toBe(!onFeature);
      expect(inv.chunks.some((chunk) => chunk.file === "worker/format.py")).toBe(!onFeature);
      expect(inv.chunks.some((chunk) => chunk.file === "worker/lib/render_output.py")).toBe(onFeature);
      expect(inv.chunks.some((chunk) => chunk.name === "addedOnFeature")).toBe(onFeature);
      expect(JSON.stringify(warm).includes(`"worker/names.py"`)).toBe(false);
    }
  });
});

// ---------------------------------------------------------- 4. parser and grammar version change (referenced)

describe("a version change", () => {
  test("a changed version key invalidates the cache and the output still equals a cold run", async () => {
    const repo = await copyFixture("webhook-service");
    await taskRun(repo, WEBHOOK_TASK, true);
    // The version keys are recorded in meta.json; make them differ the way a new parser or grammar would.
    const metaPath = join(storeDir(repo), "meta.json");
    const meta = await readJson<{ keys?: Record<string, string>; versions?: Record<string, string> }>(metaPath);
    const recorded = meta.keys ?? meta.versions ?? (meta as unknown as Record<string, string>);
    const field = "treeSitter" in recorded ? "treeSitter" : Object.keys(recorded).find((key) => key !== "root")!;
    recorded[field] = "0.0.0-older";
    await writeFile(metaPath, JSON.stringify(meta));

    const warm = await expectOutputEquivalent(repo, WEBHOOK_TASK);
    expect(warm.cache?.cold).toBe(true);
    expect(warm.cache?.files.reused).toBe(0);
    // The rewrite healed the cache: the next run is warm again, still equal.
    const next = await expectOutputEquivalent(repo, WEBHOOK_TASK);
    expect(next.cache?.cold).toBe(false);
    expect(next.cache?.files.refreshed).toBe(0);
  });
});

// ----------------------------------------------------------------------------- 5. interrupted writes (SIGKILL)

describe("a run killed mid-write", () => {
  async function plantLock(repo: string, ageMs: number) {
    const lock = join(storeDir(repo), "lock");
    const created = Date.now() - ageMs;
    await writeFile(lock, JSON.stringify({ token: "planted-by-the-test", createdAt: created }));
    await utimes(lock, new Date(created), new Date(created));
    return lock;
  }

  // Each point freezes the child at a known step of a cache write (tests/helpers/kill-point-hook.mjs), so the kill
  // provably lands mid-write: the test waits for the hook's marker file, never for a lucky poll.
  const HOOK = join(ROOT, "tests/helpers/kill-point-hook.mjs");
  const KILL_POINTS = [
    { label: "right after the store lock is created", point: "lock" },
    { label: "with a document flushed under its temporary name", point: "tmp" },
    { label: "after the first document is renamed into place", point: "json:1" },
    { label: "after the third document is renamed into place", point: "json:3" },
  ];

  for (const { label, point } of KILL_POINTS) {
    test(`SIGKILL ${label}: the next run succeeds, equals a cold run, and the cache heals`, async () => {
      const repo = await copyFixture("webhook-service");
      const cold = await runChild(repo, WEBHOOK_TASK, "--no-cache");
      expect(cold.code).toBe(0);

      const marker = join(tmp, `frozen-${point.replace(":", "-")}`);
      const victim = spawnNode(["--import", HOOK, CLI, ...taskArgv(repo, WEBHOOK_TASK)], {
        KILL_POINT: point,
        KILL_MARKER: marker,
      });
      try {
        // The child freezes itself at the point; the marker proves it got there before anything else happened.
        const deadline = Date.now() + POLL_CAP_MS;
        while (!existsSync(marker) && Date.now() < deadline && victim.child.exitCode === null) await sleep(5);
        expect(existsSync(marker)).toBe(true);
        expect(victim.child.exitCode).toBeNull();
        victim.child.kill("SIGKILL"); // only the child this test spawned, through its own handle
        const killed = await victim.done;
        expect(killed.signal).toBe("SIGKILL");
      } finally {
        await reap(victim);
      }
      const left = await readdir(storeDir(repo));
      if (point === "lock") expect(left).toContain("lock");
      if (point === "tmp") expect(left.some((name) => name.endsWith(".tmp"))).toBe(true);
      if (point.startsWith("json:")) expect(left.some((name) => name.endsWith(".json"))).toBe(true);
      const lockLeft = existsSync(join(storeDir(repo), "lock"));

      // The next run: no error, correct output, and no longer than the documented lock wait (2 s) plus a run.
      const next = await runChild(repo, WEBHOOK_TASK);
      expect(next.code).toBe(0);
      expect(normalize(next.json!)).toEqual(normalize(cold.json!));
      expect(next.ms).toBeLessThan(15_000);
      if (lockLeft) expect(next.stderr).toContain("cache busy");

      // Age a leftover lock past the stale threshold (30 s), as time passing would.
      if (existsSync(join(storeDir(repo), "lock"))) await plantLock(repo, 60_000);
      const healed = await runChild(repo, WEBHOOK_TASK);
      expect(healed.code).toBe(0);
      expect(normalize(healed.json!)).toEqual(normalize(cold.json!));
      expect(healed.stderr).not.toContain("cache busy");

      // Whatever the kill left, the store is readable, holds no lock, and the following run is warm.
      expect(existsSync(join(storeDir(repo), "lock"))).toBe(false);
      expect((await cacheStatus(repo)).documents.unreadable).toEqual([]);
      const warm = await runChild(repo, WEBHOOK_TASK);
      expect(warm.code).toBe(0);
      expect(normalize(warm.json!)).toEqual(normalize(cold.json!));
      expect(warm.json!.cache).toMatchObject({ cold: false, files: { refreshed: 0 } });
    }, 90_000);
  }

  test("a leftover fresh lock only costs the documented wait: correct output, not cached", async () => {
    const repo = await copyFixture("webhook-service");
    await runChild(repo, WEBHOOK_TASK); // creates the store, with the built CLI's own analyzer fingerprint
    const retry = join(repo, "src/util/retry.ts");
    await writeFile(retry, `${await readFile(retry, "utf8")}\n// edited so that the next run must commit\n`);
    const lock = await plantLock(repo, 1_000);

    const run = await runChild(repo, WEBHOOK_TASK);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("cache busy");
    expect(run.ms).toBeLessThan(15_000);
    expect(existsSync(lock)).toBe(true); // not ours, not stale: left alone
    expect(normalize(run.json!)).toEqual(normalize((await runChild(repo, WEBHOOK_TASK, "--no-cache")).json!));
  }, 90_000);

  test("a stale lock is broken by the next run, which then caches normally", async () => {
    const repo = await copyFixture("webhook-service");
    await runChild(repo, WEBHOOK_TASK);
    const retry = join(repo, "src/util/retry.ts");
    await writeFile(retry, `${await readFile(retry, "utf8")}\n// edited so that the next run must commit\n`);
    const lock = await plantLock(repo, 120_000);

    const run = await runChild(repo, WEBHOOK_TASK);
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("cache busy");
    expect(existsSync(lock)).toBe(false);
    expect(run.json!.cache!.files.refreshed).toBe(1);
    const warm = await runChild(repo, WEBHOOK_TASK);
    expect(warm.json!.cache).toMatchObject({ cold: false, files: { refreshed: 0, removed: 0 } });
    expect(normalize(warm.json!)).toEqual(normalize((await runChild(repo, WEBHOOK_TASK, "--no-cache")).json!));
  }, 90_000);

  test("a truncated document left by a crash is rebuilt and the output equals a cold run", async () => {
    const repo = await copyFixture("webhook-service");
    await runChild(repo, WEBHOOK_TASK);
    const shards = (await readdir(storeDir(repo))).filter((name) => name.startsWith("analysis-"));
    const target = join(storeDir(repo), shards[0]!);
    await truncate(target, Math.floor((await stat(target)).size / 2));
    await writeFile(join(storeDir(repo), "files.json"), '{"schemaVersion":1,"files":{');
    const run = await runChild(repo, WEBHOOK_TASK);
    expect(run.code).toBe(0);
    expect(normalize(run.json!)).toEqual(normalize((await runChild(repo, WEBHOOK_TASK, "--no-cache")).json!));
    expect((await cacheStatus(repo)).documents.unreadable).toEqual([]);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------- 6. concurrent runs

describe("concurrent CLI runs against one repository", () => {
  const assertSettled = async (repo: string) => {
    expect(existsSync(join(storeDir(repo), "lock"))).toBe(false);
    const status = await cacheStatus(repo);
    expect(status.documents.unreadable).toEqual([]);
    expect(status.versions.state).not.toBe("no metadata"); // the built CLI wrote meta; its keys differ from src/'s
  };

  for (const [label, tasks] of [
    ["the same task", [WEBHOOK_TASK, WEBHOOK_TASK]],
    ["different tasks", [WEBHOOK_TASK, WEBHOOK_TASK_2]],
  ] as const) {
    test(`two processes, ${label}: both succeed with cold-equal output and the store verifies (3 rounds)`, async () => {
      const repo = await copyFixture("webhook-service");
      const cold = new Map<string, Json>();
      for (const task of new Set(tasks)) cold.set(task, (await runChild(repo, task, "--no-cache")).json!);

      for (let round = 0; round < 3; round++) {
        // Rounds 0 and 1 start from an empty store (both runs race to create it); round 2 starts warm after an edit.
        if (round < 2) await rm(join(repo, ".scope"), { recursive: true, force: true });
        else
          await writeFile(
            join(repo, "src/util/retry.ts"),
            `${await readFile(join(repo, "src/util/retry.ts"), "utf8")}\n// round ${round}\n`,
          );
        if (round === 2)
          for (const task of new Set(tasks)) cold.set(task, (await runChild(repo, task, "--no-cache")).json!);

        const spawned = tasks.map((task) => spawnCli(taskArgv(repo, task)));
        try {
          const results = await Promise.all(spawned.map((one) => one.done));
          results.forEach((result, index) => {
            expect(result.code).toBe(0);
            expect(result.stderr).not.toContain("cache lock lost");
            expect(normalize(JSON.parse(result.stdout) as Json)).toEqual(normalize(cold.get(tasks[index]!)!));
          });
        } finally {
          await Promise.all(spawned.map(reap));
        }
        await assertSettled(repo);
        // Whatever the two commits left, the next run is correct and sees a usable cache.
        for (const task of new Set(tasks)) {
          const next = await runChild(repo, task);
          expect(next.code).toBe(0);
          expect(normalize(next.json!)).toEqual(normalize(cold.get(task)!));
        }
        await assertSettled(repo);
      }
    }, 120_000);
  }
});

describe("the first runs of a new user", () => {
  test("processes racing to create the per-user integrity key all get the same usable key", async () => {
    const script =
      `import { loadIntegrityKey } from ${JSON.stringify(join(ROOT, "dist/cache/integrity.js"))};` +
      "const result = await loadIntegrityKey();" +
      'process.stdout.write("key" in result ? result.key.toString("hex") : `WARNING ${result.warning}`);';
    for (let round = 0; round < 20; round++) {
      const home = await mkdtemp(join(tmp, "state-"));
      const children = Array.from({ length: 8 }, () =>
        spawnNode(["--input-type=module", "-e", script], { XDG_STATE_HOME: home }),
      );
      try {
        const results = await Promise.all(children.map((one) => one.done));
        for (const result of results) expect(result.code).toBe(0);
        expect(results.map((result) => result.stdout)).toEqual(Array(8).fill(results[0]!.stdout));
        expect(results[0]!.stdout).toMatch(/^[0-9a-f]{64}$/);
        expect((await readdir(join(home, "scope"))).sort()).toEqual(["cache-key"]);
      } finally {
        await Promise.all(children.map(reap));
      }
    }
  }, 120_000);
});

// ----------------------------------------------------------------------------------- 7. repository isolation

describe("repository isolation", () => {
  test("a store planted from another repository is a miss, and the output equals a cold run", async () => {
    const a = await copyFixture("webhook-service", "repo-a");
    const b = await copyFixture("mixed-app", "repo-b");
    await taskRun(a, WEBHOOK_TASK, true);
    await taskRun(b, MIXED_TASK, true);
    const storeOfA = await digestTree(join(a, ".scope"));

    // A's valid, correctly signed store dropped into B: wrong root, so B rebuilds and shows nothing of A.
    await rm(join(b, ".scope"), { recursive: true });
    await cp(join(a, ".scope"), join(b, ".scope"), { recursive: true });
    const planted = await expectOutputEquivalent(b, MIXED_TASK);
    expect(planted.cache?.cold).toBe(true);
    expect(planted.cache?.files.reused).toBe(0);
    expect(JSON.stringify(planted)).not.toContain("src/stripe/handler.ts");
    expect((await inventory(b, true)).chunks.every((chunk) => !chunk.file.startsWith("src/stripe/"))).toBe(true);

    // B's runs never changed A's store, and A is still warm.
    expect(await digestTree(join(a, ".scope"))).toEqual(storeOfA);
    const warmA = await expectOutputEquivalent(a, WEBHOOK_TASK);
    expect(warmA.cache).toMatchObject({ cold: false, files: { refreshed: 0 } });
  });

  test("a copy of a repository with its .scope/ does not reuse the original cache or touch it", async () => {
    const original = await copyFixture("webhook-service", "original");
    await taskRun(original, WEBHOOK_TASK, true);
    const copy = join(tmp, "copy");
    await cp(original, copy, { recursive: true });
    const storeOfOriginal = await digestTree(join(original, ".scope"));

    const first = await expectOutputEquivalent(copy, WEBHOOK_TASK);
    expect(first.cache?.cold).toBe(true);
    expect(first.cache?.files).toMatchObject({ reused: 0 });
    expect(first.cache!.files.refreshed).toBeGreaterThan(0);
    expect(await digestTree(join(original, ".scope"))).toEqual(storeOfOriginal);

    // Edit the copy only: the original does not notice, and stays warm and equal to cold.
    const retry = join(copy, "src/util/retry.ts");
    await writeFile(retry, `${await readFile(retry, "utf8")}\n// only the copy\n`);
    await expectOutputEquivalent(copy, WEBHOOK_TASK);
    expect(await digestTree(join(original, ".scope"))).toEqual(storeOfOriginal);
    const warm = await expectOutputEquivalent(original, WEBHOOK_TASK);
    expect(warm.cache).toMatchObject({ cold: false, files: { refreshed: 0, removed: 0 } });
    expect(JSON.stringify(warm)).not.toContain("only the copy");

    const status = await cacheStatus(copy);
    expect(status.root).toBe(await realpath(copy));
    expect(status.versions.state).not.toBe("no metadata"); // the built CLI wrote meta; its keys differ from src/'s
  });

  test("a symlinked .scope is not read, written or removed through, and the run still equals a cold run", async () => {
    const repo = await copyFixture("webhook-service");
    const elsewhere = join(tmp, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(repo, ".scope"));
    const run = await taskRun(repo, WEBHOOK_TASK, true);
    expect(normalize(run)).toEqual(normalize(await taskRun(repo, WEBHOOK_TASK, false)));
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ 8. explicit clearing

describe("explicit clearing", () => {
  test("clear --yes, then a run, equals a cold run and rebuilds the cache", async () => {
    const repo = await copyFixture("mixed-app");
    await expectOutputEquivalent(repo, MIXED_TASK);
    expect(existsSync(storeDir(repo))).toBe(true);

    const cleared = await cli("cache", "clear", "--repo", repo, "--yes");
    expect(cleared.code).toBe(0);
    expect((await readdir(storeDir(repo)).catch(() => [])).filter((name) => name.endsWith(".json"))).toEqual([]);

    const afterClear = await expectOutputEquivalent(repo, MIXED_TASK);
    expect(afterClear.cache?.cold).toBe(true);
    expect(afterClear.cache?.files.reused).toBe(0);
    const warm = await expectOutputEquivalent(repo, MIXED_TASK);
    expect(warm.cache).toMatchObject({ cold: false, files: { refreshed: 0 } });
    expect((await cacheStatus(repo)).documents.unreadable).toEqual([]);
  });

  test("rebuild equals a cold run, reanalyzes every file and leaves a warm cache", async () => {
    const repo = await copyFixture("mixed-app");
    const populated = await expectOutputEquivalent(repo, MIXED_TASK);
    const total = populated.cache!.files.reused + populated.cache!.files.refreshed;
    await expectInventoryEquivalent(repo);

    const rebuilt = await cli("cache", "rebuild", "--repo", repo);
    expect(rebuilt.code).toBe(0);
    expect(await inventory(repo, true)).toEqual(await inventory(repo, false));
    const after = await expectOutputEquivalent(repo, MIXED_TASK);
    expect(after.cache).toMatchObject({ cold: false, files: { refreshed: 0, removed: 0 } });
    expect(after.cache!.files.reused).toBe(total);
  });

  test("reset-weights leaves the analysis alone: same bytes, and the next run is warm and equal to cold", async () => {
    const repo = await copyFixture("webhook-service");
    await expectOutputEquivalent(repo, WEBHOOK_TASK);
    const before = await digestTree(storeDir(repo));
    const reset = await cli("cache", "reset-weights", "--repo", repo);
    expect(reset.code).toBe(0);
    expect(await digestTree(storeDir(repo))).toEqual(before);
    const warm = await expectOutputEquivalent(repo, WEBHOOK_TASK);
    expect(warm.cache).toMatchObject({ cold: false, files: { refreshed: 0, removed: 0 } });
  });
});

// ---------------------------------------------------------------------- 9. corruption, end to end (referenced)

describe("corrupted history, decisions, feedback and weights", () => {
  test("after each is damaged, a Jev run equals a run that never had a cache", async () => {
    const repo = await copyFixture("webhook-service");
    let clock = Date.now();
    const now = () => (clock += 1000);
    const provider = fakeProvider({ relevance: { withRetry: 0.9, computeBackoff: 0.8 }, fallback: 0.05 });
    const jevRun = async (task: string, cache: boolean) => {
      const { result } = await runScope({ task, repo, provider, cache, cacheOptions: { now, env: {} } });
      return { result, json: JSON.parse(renderFormat("json", result)) as Json };
    };

    const seeded = await jevRun(WEBHOOK_TASK, true);
    await submitFeedback(
      { runId: seeded.result.runId!, useful: [seeded.result.chunks[0]!.chunk.id], irrelevant: [], missing: [] },
      { repo, env: {}, cacheOptions: { now } },
    );
    // Control: while the documents are healthy the repeat is served from them.
    const healthy = await jevRun(WEBHOOK_TASK, true);
    expect(healthy.json.decisionsReusedFrom).toBeDefined();

    const names = await readdir(storeDir(repo));
    for (const prefix of ["history-", "decision-", "feedback-"]) {
      const documents = names.filter((name) => name.startsWith(prefix));
      expect(documents.length).toBeGreaterThan(0);
      for (const name of documents) await writeFile(join(storeDir(repo), name), '{"schemaVersion":1,"records":[');
    }
    await writeFile(join(storeDir(repo), "weights-active.json"), "{ not json");

    const damaged = await jevRun(WEBHOOK_TASK, true);
    const cold = await jevRun(WEBHOOK_TASK, false);
    expect(damaged.json.decisionsReusedFrom).toBeUndefined();
    expect(normalize(damaged.json)).toEqual(normalize(cold.json));
  });
});
