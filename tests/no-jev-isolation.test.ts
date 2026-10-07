// `--no-jev` is the offline baseline: it must never build the SDK client, read the Jev credentials or open a
// connection. Proved on the compiled CLI in a subprocess, two independent ways:
//   1. A preload (tests/helpers/isolation-probe.mjs) records every read of a TYPESAFE_* variable and every network
//      attempt (fetch, sockets, TLS, HTTP, DNS), and makes the attempt fail.
//   2. A recording local server stands in for Jev (TYPESAFE_BASE_URL) and must receive zero requests.
// Positive controls run the default (Jev) path under the same probe and server, so the checks cannot pass vacuously.
// Needs `bun run build` (skipped otherwise, like tests/subprocess.test.ts); `SCOPE_NODE` picks the Node under test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMATS } from "../src/output/index.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "dist/cli.js");
const PROBE = join(import.meta.dir, "helpers/isolation-probe.mjs");
const NODE = process.env.SCOPE_NODE ?? "node";
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";
const SENTINEL_KEY = "sentinel-key-never-sent-0000";

let workdir: string;
let server: Server;
let serverUrl: string;
let serverRequests = 0;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "scope-isolation-"));
  server = createServer((_request, response) => {
    serverRequests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workdir, { recursive: true, force: true });
});

interface Probed {
  code: number | null;
  stdout: string;
  stderr: string;
  events: string[];
  serverRequests: number;
}

let runs = 0;
/** Runs the compiled CLI under the probe, with a sentinel key and the recording server as the Jev endpoint. */
async function probed(args: string[], key = SENTINEL_KEY): Promise<Probed> {
  const log = join(workdir, `probe-${runs++}.log`);
  const before = serverRequests;
  const env = { ...process.env, SCOPE_PROBE_LOG: log, TYPESAFE_API_KEY: key, TYPESAFE_BASE_URL: serverUrl };
  const result = await new Promise<Pick<Probed, "code" | "stdout" | "stderr">>((resolve, reject) => {
    const proc = spawn(NODE, ["--import", PROBE, CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const events = existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter((line) => line !== "") : [];
  return { ...result, events, serverRequests: serverRequests - before };
}

const suite = existsSync(CLI) ? describe : describe.skip;

suite("--no-jev isolation (compiled CLI, subprocess)", () => {
  const offline = [
    ["default format", []],
    ...FORMATS.map((format) => [`--format ${format}`, ["--format", format]] as const),
    ["--explain", ["--explain"]],
    ["--explain --format json", ["--explain", "--format", "json"]],
  ] as const;

  for (const [name, extra] of offline) {
    test(`${name}: succeeds with no TYPESAFE_* read, no network attempt and no request to the endpoint`, async () => {
      const run = await probed([TASK, "--repo", FIXTURE, "--no-jev", ...extra]);
      expect(run.code).toBe(0);
      expect(run.stdout.length).toBeGreaterThan(0);
      expect(run.stderr).not.toContain(SENTINEL_KEY);
      expect(run.events).toEqual([]);
      expect(run.serverRequests).toBe(0);
    });
  }

  test("--no-jev ignores a missing key as well as a present one", async () => {
    const run = await probed([TASK, "--repo", FIXTURE, "--no-jev"], "");
    expect(run.code).toBe(0);
    expect(run.events).toEqual([]);
  });

  // Positive controls: the same probe and server do see the default path.
  test("control: the default path under the probe reads the key and fails when it is missing", async () => {
    const run = await probed([TASK, "--repo", FIXTURE], "");
    expect(run.code).toBe(3);
    expect(run.events).toContain("env: TYPESAFE_API_KEY");
  });

  test("control: the default path under the probe tries to reach the network and the attempt is recorded", async () => {
    const run = await probed([TASK, "--repo", FIXTURE]);
    expect(run.code).not.toBe(0);
    expect(run.events).toContain("env: TYPESAFE_API_KEY");
    expect(run.events.some((event) => event.startsWith("network: "))).toBe(true);
    expect(run.serverRequests).toBe(0); // the probe blocked it before it left the process
  });

  test("control: without the probe's blocking, the recording server does see the default path's requests", async () => {
    const before = serverRequests;
    const code = await new Promise<number | null>((resolve, reject) => {
      const proc = spawn(NODE, [CLI, TASK, "--repo", FIXTURE], {
        cwd: ROOT,
        env: { ...process.env, TYPESAFE_API_KEY: SENTINEL_KEY, TYPESAFE_BASE_URL: serverUrl },
      });
      proc.on("error", reject);
      proc.on("close", resolve);
      proc.stdout.resume();
      proc.stderr.resume();
    });
    expect(code).toBe(6);
    expect(serverRequests).toBeGreaterThan(before);
  }, 30_000);
});
