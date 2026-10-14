import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevPathPriorProvider, type PathPriorProvider } from "../src/jev/path-prior.ts";
import type { JevClient } from "../src/jev/provider.ts";
import { runScope, UsageError } from "../src/scope.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

type Request = Parameters<JevClient["systemOne"]>[0];

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scope-prior-"));
  const write = async (path: string, content: string | Buffer) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write(".gitignore", "build-notes/\n");
  await write("src/orders.ts", "export function createOrder() { return 1; }\n");
  await write("src/billing.ts", "export function chargeCard() { return 2; }\n");
  await write(".env.production", "TOKEN=abc\n");
  await write("secret-keys", "key\n");
  await write("build-notes/plan.md", "# plan\n");
  await write("node_modules/pkg/index.js", "module.exports = 1;\n");
  await write("blob.ts", Buffer.from([0, 1, 2, 3]));
  return root;
}

function recordingClient() {
  const requests: Request[] = [];
  const client: JevClient = {
    async systemOne(request) {
      requests.push(request);
      const dirs = request.state.directories as Record<string, { entries: Record<string, string> }>;
      const answers = Object.fromEntries(
        Object.entries(dirs).map(([k, d]) => [
          k,
          { probabilities: Object.fromEntries(Object.keys(d.entries).map((l) => [l, 0.5])) },
        ]),
      );
      return { answers, usage: { input_tokens: 7, output_tokens: 1 } };
    },
  };
  return { client, requests };
}

test("no excluded path reaches any path-prior request, and the run reports the prior", async () => {
  const root = await repo();
  try {
    const { client, requests } = recordingClient();
    const run = await runScope({
      task: "change order creation",
      repo: root,
      provider: fakeProvider({ fallback: 0.5 }),
      pathPrior: { provider: new JevPathPriorProvider({ client }) },
    });
    expect(requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(requests);
    expect(sent).toContain("orders.ts");
    for (const name of [".env", "secret-keys", "build-notes", "plan.md", "node_modules", "pkg", "blob"])
      expect(sent).not.toContain(name);
    expect(run.pathPrior).toMatchObject({ requestCount: requests.length, usage: { inputTokens: 7 * requests.length } });
    expect(run.pathPrior!.contribution.boosted).toBeGreaterThan(0);
    expect(run.candidates.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a custom provider's scores steer the shortlist, and runs without the option report no prior", async () => {
  const root = await repo();
  try {
    const seen: string[][] = [];
    const provider: PathPriorProvider = {
      async rank({ files }) {
        seen.push([...files]);
        return {
          scores: new Map(files.map((f) => [f, f === "src/billing.ts" ? 1 : 0])),
          requestCount: 0,
          questionCount: 0,
          latencyMs: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const plain = await runScope({ task: "unrelated words", repo: root, provider: fakeProvider({ fallback: 0.5 }) });
    expect(plain.pathPrior).toBeUndefined();
    const run = await runScope({
      task: "unrelated words",
      repo: root,
      provider: fakeProvider({ fallback: 0.5 }),
      pathPrior: { provider },
    });
    expect(seen[0]).toEqual([".gitignore", "src/billing.ts", "src/orders.ts"]);
    expect(run.pathPrior!.contribution.added).toEqual(["src/billing.ts"]);
    expect(run.candidates[0]!.file).toBe("src/billing.ts");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the path prior cannot be combined with noJev", async () => {
  const root = await repo();
  try {
    await expect(runScope({ task: "x", repo: root, noJev: true, pathPrior: true })).rejects.toBeInstanceOf(UsageError);
  } finally {
    await rm(root, { recursive: true });
  }
});
