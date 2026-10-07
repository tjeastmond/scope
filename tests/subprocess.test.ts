// End-to-end checks of the compiled CLI as a real subprocess: what reaches stdout and stderr, exit codes, hostile source
// content and repeatability. The Node under test is `SCOPE_NODE` (default: `node` on PATH), so the same suite runs on
// Node 24 and 26:  bun run build && SCOPE_NODE=~/.nvm/versions/node/v26.10.0/bin/node bun test tests/subprocess.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { FORMATS } from "../src/output/index.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "dist/cli.js");
const NODE = process.env.SCOPE_NODE ?? "node";
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const MIXED = join(ROOT, "fixtures/mixed-app");
const TASK = "Add retry handling to Stripe webhook processing";
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "docs/scope-result.schema.json"), "utf8")),
);

interface Run {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

// A key in the environment must never decide a result, and none of these runs may contact Jev.
const env = { ...process.env, TYPESAFE_API_KEY: "" };
const scope = (...args: string[]): Run => {
  const proc = spawnSync(NODE, [CLI, ...args], { cwd: ROOT, env, maxBuffer: 256 * 1024 * 1024 });
  return { stdout: proc.stdout, stderr: proc.stderr.toString("utf8"), code: proc.status };
};
const text = (run: Run) => run.stdout.toString("utf8");

/** Every stderr line is a diagnostic: `scope: ...`. Nothing else (a stack trace, a result fragment) belongs there. */
const expectDiagnosticsOnly = (stderr: string) => {
  for (const line of stderr.split("\n").filter((entry) => entry !== "")) expect(line).toMatch(/^scope: /);
};

const built = existsSync(CLI);
const suite = built ? describe : describe.skip;

suite("the compiled CLI as a subprocess", () => {
  test("runs under Node 24 or newer", () => {
    const version = spawnSync(NODE, ["--version"], { encoding: "utf8" }).stdout.trim();
    expect(Number(/^v(\d+)\./.exec(version)?.[1])).toBeGreaterThanOrEqual(24);
  });

  describe("stdout and stderr", () => {
    for (const format of FORMATS) {
      test(`--format ${format}: the artifact is on stdout alone, diagnostics on stderr, exit 0`, () => {
        const run = scope(TASK, "--repo", MIXED, "--no-jev", "--format", format);
        expect(run.code).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(run.stderr).toContain("scope: warning:");
        expect(text(run)).not.toContain("scope: ");
        if (format === "json") {
          const parsed = JSON.parse(text(run));
          expect(validate(parsed)).toBe(true);
          expect(parsed.mode).toBe("no-jev");
          // The same warnings appear in the artifact and on stderr.
          for (const warning of parsed.warnings) expect(run.stderr).toContain(`scope: warning: ${warning}\n`);
        } else {
          expect(text(run).startsWith(format === "markdown" ? "# Scope context" : "Scope context for:")).toBe(true);
        }
      });
    }

    test("--output writes the artifact to the file and leaves stdout empty", async () => {
      const directory = await mkdtemp(join(tmpdir(), "scope-sub-"));
      try {
        const target = join(directory, "out.json");
        const run = scope(TASK, "--repo", FIXTURE, "--no-jev", "--format", "json", "--output", target);
        expect(run.code).toBe(0);
        expect(run.stdout.length).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(run.stderr).toContain(`scope: wrote ${target}`);
        expect(validate(JSON.parse(await readFile(target, "utf8")))).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  describe("exit codes", () => {
    const failing: [string, string[], number, RegExp][] = [
      ["the default path without a Jev key", [TASK, "--repo", FIXTURE], 3, /TYPESAFE_API_KEY/],
      [
        "an unwritable --output directory",
        [TASK, "--repo", FIXTURE, "--no-jev", "--output", "/no/such/dir/x.md"],
        1,
        /cannot write --output/,
      ],
      ["an unknown format", [TASK, "--repo", FIXTURE, "--no-jev", "--format", "yaml"], 2, /--format must be one of/],
      [
        "the removed --budget option",
        [TASK, "--repo", FIXTURE, "--no-jev", "--budget", "8000"],
        2,
        /Unknown option '--budget'.*no token budget/,
      ],
      ["an empty task", ["  ", "--repo", FIXTURE, "--no-jev"], 2, /task description is empty/],
      ["a missing repository", [TASK, "--repo", "/no/such/repo", "--no-jev"], 2, /./],
    ];
    for (const [name, args, code, message] of failing) {
      test(`${name}: exit ${code}, nothing on stdout, diagnostics on stderr`, () => {
        const run = scope(...args);
        expect(run.code).toBe(code);
        expect(run.stdout.length).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(run.stderr).toMatch(message);
      });
    }

    test("SCOPE_JEV_PAYLOAD=print prints the request bodies as JSON without a key and sends nothing", () => {
      const proc = spawnSync(NODE, [CLI, TASK, "--repo", FIXTURE], {
        cwd: ROOT,
        env: { ...env, SCOPE_JEV_PAYLOAD: "print" },
        maxBuffer: 256 * 1024 * 1024,
      });
      expect(proc.status).toBe(0);
      expectDiagnosticsOnly(proc.stderr.toString("utf8"));
      expect(proc.stderr.toString("utf8")).toContain("nothing was sent");
      const requests = JSON.parse(proc.stdout.toString("utf8"));
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].state.task).toBe(TASK);
    });

    test("--help exits 0 with usage on stdout", () => {
      const run = scope("--help");
      expect(run.code).toBe(0);
      expect(text(run)).toContain("Usage: scope");
    });

    test("nothing relevant is a success: an empty artifact and a warning", () => {
      const run = scope("quuxfrobnicate", "--repo", MIXED, "--format", "json");
      expect(run.code).toBe(0);
      expect(JSON.parse(text(run)).regions).toEqual([]);
      expect(run.stderr).toContain("scope: warning: No relevant chunks found");
    });
  });

  // Every Jev failure class against a local fake of the Jev API (the SDK honours TYPESAFE_BASE_URL). The server must
  // answer while the CLI runs, so these use async `spawn`, not `spawnSync`. The key is a fake that never leaves the
  // machine. A timeout (exit 5) is not covered here: attempts last 30 s and the deadline 90 s, and shipped code has no
  // override; tests/exit-codes.test.ts covers exit 5 through main() with a fake provider.
  describe("Jev failures against a fake Jev server", () => {
    const FAKE_KEY = "fake-key-for-subprocess-tests";
    type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

    const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const answersFor = (body: string, noul = 0.9) => ({
      answers: Object.fromEntries(Object.keys(JSON.parse(body).questions).map((ref) => [ref, { type: "noul", noul }])),
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const startServer = async (handler: Handler) => {
      const requests: string[] = [];
      const server: Server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          requests.push(body);
          handler(request, response, body);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const stop = () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      return { url: `http://127.0.0.1:${port}`, requests, stop };
    };

    interface AsyncRun extends Run {
      signal: NodeJS.Signals | null;
    }
    const scopeAsync = (baseUrl: string | undefined, key: string, onStart?: (kill: () => void) => void) =>
      new Promise<AsyncRun>((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: key };
        if (baseUrl === undefined) delete childEnv.TYPESAFE_BASE_URL;
        else childEnv.TYPESAFE_BASE_URL = baseUrl;
        const proc = spawn(NODE, [CLI, TASK, "--repo", FIXTURE], { cwd: ROOT, env: childEnv });
        const out: Buffer[] = [];
        let err = "";
        proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
        proc.on("error", reject);
        proc.on("close", (code, signal) => resolve({ stdout: Buffer.concat(out), stderr: err, code, signal }));
        let interrupted = false;
        // Once: the CLI sends several requests at once, and a second Ctrl-C terminates the process by design.
        onStart?.(() => {
          if (!interrupted) proc.kill("SIGINT");
          interrupted = true;
        });
      });

    /** Runs the CLI against a fake server with `handler` and checks the failure's label, guidance and exit code. */
    const expectFailure = async (handler: Handler, code: number, label: RegExp) => {
      const server = await startServer(handler);
      try {
        const run = await scopeAsync(server.url, FAKE_KEY);
        expect(run.code).toBe(code);
        expect(run.stdout.length).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        const lines = run.stderr.split("\n").filter((line) => line !== "");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(label);
        expect(lines[1]).toMatch(/^scope: .*--no-jev/);
        expect(run.stderr).not.toContain(FAKE_KEY);
      } finally {
        await server.stop();
      }
    };

    test("a valid answer exits 0 with the artifact on stdout (the harness works)", async () => {
      const server = await startServer((_request, response, body) => json(response, 200, answersFor(body)));
      try {
        const run = await scopeAsync(server.url, FAKE_KEY);
        expect(run.code).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(text(run).startsWith("Scope context for:")).toBe(true);
        expect(server.requests.length).toBeGreaterThan(0);
      } finally {
        await server.stop();
      }
    });

    test("a missing key: exit 3, nothing sent", async () => {
      const server = await startServer((_request, response) => json(response, 200, {}));
      try {
        const run = await scopeAsync(server.url, "");
        expect(run.code).toBe(3);
        expect(run.stdout.length).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(run.stderr).toContain("scope: Jev unavailable: TYPESAFE_API_KEY is not set.");
        expect(run.stderr).toMatch(/scope: Set TYPESAFE_API_KEY.*--no-jev/);
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.stop();
      }
    });

    test("HTTP 401: exit 3", () =>
      expectFailure((_request, response) => json(response, 401, { detail: "no" }), 3, /Jev unavailable: .*401/));

    test(
      "HTTP 429: exit 4",
      () =>
        expectFailure(
          (_request, response) => json(response, 429, { detail: "slow down" }, { "retry-after-ms": "0" }),
          4,
          /Jev unavailable: .*rate limit/,
        ),
      20_000,
    );

    test(
      "HTTP 503: exit 6",
      () =>
        expectFailure(
          (_request, response) => json(response, 503, { detail: "unavailable" }, { "retry-after-ms": "0" }),
          6,
          /Jev unavailable: .*503/,
        ),
      20_000,
    );

    test("a closed port (connection refused): exit 6", async () => {
      const probe = await startServer(() => {});
      const closed = probe.url;
      await probe.stop();
      const run = await scopeAsync(closed, FAKE_KEY);
      expect(run.code).toBe(6);
      expect(run.stdout.length).toBe(0);
      expectDiagnosticsOnly(run.stderr);
      expect(run.stderr).toContain("scope: Jev unavailable: Could not reach Jev");
      expect(run.stderr).toMatch(/scope: Check your network.*--no-jev/);
    }, 30_000);

    test("HTTP 200 with no usable answers: exit 7", () =>
      expectFailure(
        (_request, response) => json(response, 200, { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
        7,
        /Jev returned an unusable response:/,
      ));

    test("HTTP 200 with an out-of-range relevance: exit 7", () =>
      expectFailure(
        (_request, response, body) => json(response, 200, answersFor(body, 7)),
        7,
        /Jev returned an unusable response:.*invalid relevance/,
      ));

    test("HTTP 400 max_tokens_exceeded: exit 8", () =>
      expectFailure(
        (_request, response) => json(response, 400, { detail: { error_type: "max_tokens_exceeded" } }),
        8,
        /Jev request not sent:/,
      ));

    test("SIGINT while Jev never answers: exit 130, empty stdout, Cancelled", async () => {
      let interrupt: (() => void) | undefined;
      const server = await startServer(() => interrupt?.()); // never answers
      try {
        const run = await scopeAsync(server.url, FAKE_KEY, (kill) => (interrupt = kill));
        expect(run.signal).toBeNull();
        expect(run.code).toBe(130);
        expect(run.stdout.length).toBe(0);
        expectDiagnosticsOnly(run.stderr);
        expect(run.stderr).toBe("scope: Cancelled: Jev request cancelled.\n");
      } finally {
        await server.stop();
      }
    });
  });

  describe("hostile source content", () => {
    const LINE = "x".repeat(100_000);
    const files: Record<string, string | Buffer> = {
      "ansi.ts": 'export function paint(): string {\n  return "\u001b[31mALERT\u001b[0m \u001b]0;title\u0007";\n}\n',
      "separators.ts": 'export function separators(): string {\n  return "a b c";\n}\n',
      "bom.ts": "﻿export function withBom(): number {\n  return 1;\n}\n",
      "crlf.ts": "export function windows(): number {\r\n  return 2;\r\n}\r\n",
      "long.ts": `export const wide = "${LINE}";\nexport function afterWide(): number {\n  return 3;\n}\n`,
      "fence.md": "# Fences\n\n````\n```ts\ncode\n```\n````\n",
      // The scanner only sniffs the start of a file, so this NUL is found when the file is analyzed.
      "late-nul.ts": `// ${"a".repeat(9000)}\nexport function binaryLate(): number {\n  return 4;\n}\n\u0000\n`,
    };
    let repo: string;
    const args = (format: string) => [
      "paint separators bom windows wide fences",
      "--repo",
      repo,
      "--no-jev",
      "--format",
      format,
    ];

    beforeAll(async () => {
      repo = await mkdtemp(join(tmpdir(), "scope-hostile-"));
      await mkdir(repo, { recursive: true });
      for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
    });
    afterAll(() => rm(repo, { recursive: true, force: true }));

    test("JSON stays valid and every region carries its source lines exactly", async () => {
      const run = scope(...args("json"));
      expect(run.code).toBe(0);
      expectDiagnosticsOnly(run.stderr);
      const parsed = JSON.parse(text(run));
      expect(validate(parsed)).toBe(true);
      const analyzed = new Set<string>();
      for (const region of parsed.regions) {
        analyzed.add(region.file);
        const lines = (await readFile(join(repo, region.file), "utf8")).split("\n");
        expect(region.content).toBe(lines.slice(region.startLine - 1, region.endLine).join("\n"));
      }
      expect([...analyzed].sort()).toEqual(["ansi.ts", "bom.ts", "crlf.ts", "fence.md", "long.ts", "separators.ts"]);
    });

    test("a NUL file is skipped with a warning and none of it reaches the artifact", () => {
      const run = scope(...args("json"));
      expect(run.stderr).toContain("late-nul.ts: binary content (NUL byte); skipped");
      expect(text(run)).not.toContain("binaryLate");
      expect(text(run)).not.toContain("\\u0000");
    });

    for (const format of ["text", "markdown"]) {
      test(`--format ${format} prints source content unchanged and keeps metadata on single lines`, () => {
        const run = scope(...args(format));
        expect(run.code).toBe(0);
        const out = text(run);
        for (const needle of ["\u001b[31mALERT", "a b c", "﻿export function withBom", "return 2;\r\n", LINE]) {
          expect(out).toContain(needle);
        }
        expect(out).not.toContain("binaryLate");
        if (format === "markdown") {
          // The fence around the Markdown file's own four-backtick fence must be longer than any run inside it.
          expect(out).toContain("`````markdown\n# Fences");
        }
      });
    }

    test("the diagnostics for hostile content contain no raw control characters", () => {
      // eslint-disable-next-line no-control-regex
      expect(scope(...args("text")).stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    });

    for (const format of FORMATS) {
      test(`--format ${format}: repeated offline runs are byte-identical`, () => {
        const first = scope(...args(format));
        const second = scope(...args(format));
        expect(first.code).toBe(0);
        expect(Buffer.compare(first.stdout, second.stdout)).toBe(0);
        expect(first.stderr).toBe(second.stderr);
      });
    }
  });
});
