import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.ts";
import { JevDecisionProvider, planJevRequests, type JevClient } from "../src/jev/provider.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";

type Call = { state: Record<string, unknown>; questions: Record<string, unknown> };

const TASK = "retry webhook delivery";
const SECRET_LITERAL = "PLANTEDLITERAL12345678";
const ENV_SECRET = "PLANTED_ENV_SECRET_VALUE";
const IGNORED = "PLANTED_IGNORED_MARKER";
const BINARY = "PLANTED_BINARY_MARKER";
const SECRET_NAMED = "PLANTED_SECRETNAME_MARKER";

let tmp: string;
const saved = { key: process.env.TYPESAFE_API_KEY, payload: process.env.SCOPE_JEV_PAYLOAD };
beforeEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.SCOPE_JEV_PAYLOAD;
  tmp = await mkdtemp(join(tmpdir(), "scope-payload-"));
  await mkdir(join(tmp, "src"));
  await writeFile(join(tmp, ".gitignore"), "ignored.ts\n");
  await writeFile(join(tmp, ".env"), `RETRY_WEBHOOK=${ENV_SECRET}\n`);
  await writeFile(join(tmp, "ignored.ts"), `export function retryWebhookIgnored() { return "${IGNORED}"; }\n`);
  await writeFile(
    join(tmp, "binary.ts"),
    Buffer.concat([
      Buffer.from(`export function retryWebhookBinary() { return "${BINARY}"; }\n`),
      // Past the scanner's 8 KiB sniff window, so only the full-content NUL check in loadChunks can exclude it.
      Buffer.from(`// ${"padding ".repeat(1200)}\n`),
      Buffer.from([0, 1, 2]),
    ]),
  );
  await writeFile(
    join(tmp, "src/secret_retry.ts"),
    `export function retryWebhookSecretNamed() { return "${SECRET_NAMED}"; }\n`,
  );
  await writeFile(
    join(tmp, "src/deliver.ts"),
    `export function retryWebhookDelivery(url: string) {\n  const apiKey = "${SECRET_LITERAL}";\n  return fetch(url, { headers: { apiKey } });\n}\n`,
  );
});
afterEach(async () => {
  for (const [name, value] of [
    ["TYPESAFE_API_KEY", saved.key],
    ["SCOPE_JEV_PAYLOAD", saved.payload],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(tmp, { recursive: true, force: true });
});

function recordingClient() {
  const calls: Call[] = [];
  const client: JevClient = {
    async systemOne(request) {
      calls.push(request);
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((ref) => [ref, { type: "noul", noul: 0.8 }]),
      );
      return { answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  return { client, calls };
}

function capture(provider?: DecisionProvider) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const chunk = (id: string, content: string): CodeChunk => ({
  id,
  file: `${id}.ts`,
  language: "typescript",
  kind: "function",
  name: id,
  startLine: 1,
  endLine: 2,
  content,
  references: [],
});

test("the request body holds the task and candidates only, with no excluded or secret content", async () => {
  const { client, calls } = recordingClient();
  const run = capture(new JevDecisionProvider({ client }));
  expect(await main([TASK, "--repo", tmp, "--format", "json"], run.io)).toBe(0);

  expect(calls.length).toBeGreaterThan(0);
  const body = JSON.stringify(calls);
  expect(body).toContain(TASK);
  expect(body).toContain("src/deliver.ts");
  expect(body).toContain("retryWebhookDelivery");
  expect(body).toContain("[REDACTED]");
  for (const planted of [SECRET_LITERAL, ENV_SECRET, IGNORED, BINARY, SECRET_NAMED, "secret_retry"]) {
    expect(body).not.toContain(planted);
  }
  for (const call of calls) {
    expect(Object.keys(call.state).sort()).toEqual(["candidates", "task"]);
    expect(call.state.task).toBe(TASK);
    for (const candidate of Object.values(call.state.candidates as Record<string, object>)) {
      expect(Object.keys(candidate)).toEqual(["path", "symbol", "kind", "lines", "code"]);
    }
  }
});

test("code over the cap is sent as a prefix plus a marker, while the artifact keeps the full chunk", async () => {
  const body = `  // ${"x".repeat(200)}\n`.repeat(20);
  await writeFile(join(tmp, "src/deliver.ts"), `export function retryWebhookDelivery() {\n${body}}\n`);
  const { client, calls } = recordingClient();
  const run = capture(new JevDecisionProvider({ client, candidateMaxChars: 500 }));
  expect(await main([TASK, "--repo", tmp, "--format", "json"], run.io)).toBe(0);

  const sent = Object.values(calls[0]!.state.candidates as Record<string, { path: string; code: string }>).find(
    (c) => c.path === "src/deliver.ts",
  )!;
  const full = `export function retryWebhookDelivery() {\n${body}}`;
  expect(sent.code).toBe(`${full.slice(0, 500)}\n[truncated for judging: showed 500 of ${full.length} characters]`);
  const region = JSON.parse(run.stdout()).regions.find((r: { file: string }) => r.file === "src/deliver.ts");
  expect(region.content).toBe(full);
});

test("truncation never splits a surrogate pair, and code at or under the cap is unchanged", () => {
  const emoji = "😀";
  const code = `${"a".repeat(9)}${emoji}${"b".repeat(5)}`;
  const [request] = planJevRequests("t", [chunk("a", code), chunk("b", "a".repeat(10))], { candidateMaxChars: 10 });
  const candidates = request!.state.candidates as Record<string, { code: string }>;
  expect(candidates.c0!.code).toBe(`${"a".repeat(9)}\n[truncated for judging: showed 9 of ${code.length} characters]`);
  expect(candidates.c1!.code).toBe("a".repeat(10));
});

test("planJevRequests returns exactly the requests the provider sends, in order, across batches", async () => {
  const candidates = ["a", "b", "c", "d"].map((id) => chunk(id, "z".repeat(400)));
  const limits = { batchMaxChars: 2200, candidateMaxChars: 300 };
  const { client, calls } = recordingClient();
  await new JevDecisionProvider({ client, ...limits }).decide({ task: "t", candidates });
  const planned = planJevRequests("t", candidates, limits);
  expect(planned.length).toBeGreaterThan(1);
  expect(planned).toEqual(calls);
});

test("SCOPE_JEV_PAYLOAD=print prints the planned requests, sends nothing and needs no key", async () => {
  process.env.SCOPE_JEV_PAYLOAD = "print";
  let called = 0;
  const run = capture({
    async decide() {
      called += 1;
      throw new Error("must not be called");
    },
  });
  expect(await main([TASK, "--repo", tmp, "--format", "json", "--explain"], run.io)).toBe(0);
  expect(called).toBe(0);

  const printed = JSON.parse(run.stdout());
  const { loadChunks } = await import("../src/scope.ts");
  const { selectCandidates } = await import("../src/retrieval/candidates.ts");
  const { chunks } = await loadChunks(tmp);
  const expected = planJevRequests(TASK, selectCandidates(TASK, chunks).candidates);
  expect(printed).toEqual(expected);
  expect(printed.length).toBeGreaterThan(0);
  const count = Object.keys(printed[0].state.candidates).length;
  expect(run.stderr()).toBe(
    `scope: printed the Jev payload (${printed.length} requests, ${count} candidates); nothing was sent\n`,
  );
});

test.each([
  ["--no-jev", "print", ["--no-jev"], /--no-jev/],
  ["--output", "print", ["--output", "out.json"], /stdout/],
  ["a bad value", "yes", [], /"print"/],
])("SCOPE_JEV_PAYLOAD with %s is a usage error", async (_name, value, extra, message) => {
  process.env.SCOPE_JEV_PAYLOAD = value;
  const run = capture();
  expect(await main([TASK, "--repo", tmp, ...extra], run.io)).toBe(2);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toMatch(message);
});
