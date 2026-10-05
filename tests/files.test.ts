import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderResult } from "../src/output/text.ts";
import { scanRepository } from "../src/repository/files.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a temp repository from a `path -> content` map; parent directories are created as needed. */
async function makeRepo(tree: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);

test("scans root, nested and negated .gitignore patterns to the expected eligible set", async () => {
  const root = await makeRepo({
    ".gitignore": "private/\n*.generated.ts\n*.skip.ts\n!credentials.ts\n!src/secrets.ts\n",
    "src/.gitignore": "private.ts\n!keep.skip.ts\n",
    "src/deep/.gitignore": "/local.ts\n",
    "src/b/two.ts": "",
    "src/a/one.tsx": "",
    "src/a/notes.md": "",
    "src/ok.ts": "",
    "src/api.generated.ts": "",
    "src/keep.skip.ts": "",
    "src/drop.skip.ts": "",
    "src/private.ts": "",
    "src/deep/local.ts": "",
    "src/deep/private.ts": "",
    "src/deep/fine.ts": "",
    "private/internal.ts": "",
    "private.ts": "",
    "credentials.ts": "",
    "src/secrets.ts": "",
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual([
    ".gitignore",
    "private.ts",
    "src/.gitignore",
    "src/a/notes.md",
    "src/a/one.tsx",
    "src/b/two.ts",
    "src/deep/.gitignore",
    "src/deep/fine.ts",
    "src/keep.skip.ts",
    "src/ok.ts",
  ]);
  expect(skipped).toEqual([
    { path: "credentials.ts", reason: "secret" },
    { path: "private/", reason: "gitignored" },
    { path: "src/api.generated.ts", reason: "gitignored" },
    { path: "src/deep/local.ts", reason: "gitignored" },
    { path: "src/deep/private.ts", reason: "gitignored" },
    { path: "src/drop.skip.ts", reason: "gitignored" },
    { path: "src/private.ts", reason: "gitignored" },
    { path: "src/secrets.ts", reason: "secret" },
  ]);
});

test("reports every skip reason with the exact path", async () => {
  const root = await makeRepo({
    "src/app.ts": "export const a = 1;\n",
    ".env": "TOKEN=x\n",
    ".env.local": "TOKEN=x\n",
    ".npmrc": "x",
    ".netrc": "x",
    "certs/server.pem": "x",
    "release.keystore": "x",
    "bun.lock": "",
    "pnpm-lock.yaml": "",
    "go.sum": "",
    "public/app.min.js": "",
    "public/site.min.css": "",
    "public/mod.min.mjs": "",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x00, 0x47]),
    "ignored.log": "x",
    ".gitignore": "*.log\n",
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual([".gitignore", "src/app.ts"]);
  expect(skipped).toEqual([
    { path: ".env", reason: "secret" },
    { path: ".env.local", reason: "secret" },
    { path: ".netrc", reason: "secret" },
    { path: ".npmrc", reason: "secret" },
    { path: "assets/logo.png", reason: "binary" },
    { path: "bun.lock", reason: "lockfile" },
    { path: "certs/server.pem", reason: "secret" },
    { path: "go.sum", reason: "lockfile" },
    { path: "ignored.log", reason: "gitignored" },
    { path: "pnpm-lock.yaml", reason: "lockfile" },
    { path: "public/app.min.js", reason: "minified" },
    { path: "public/mod.min.mjs", reason: "minified" },
    { path: "public/site.min.css", reason: "minified" },
    { path: "release.keystore", reason: "secret" },
  ]);
});

test("dependency and build directories are recorded once and never recursed into", async () => {
  const dirs = ["node_modules", ".git", "dist", "build", "out", ".next", "target", "coverage", "venv", ".venv"];
  const skippedDirs = [...dirs, "__pycache__", ".scope", "src/dist"];
  const tree: Record<string, string> = { "src/app.ts": "", "src/dist/nested.ts": "", ".scope/cache.json": "{}" };
  for (const dir of [...dirs, "__pycache__"]) tree[`${dir}/deep/file.ts`] = "";
  const { files, skipped } = await scanRepository(await makeRepo(tree));
  expect(files).toEqual(["src/app.ts"]);
  expect(skipped).toEqual(
    skippedDirs.map((dir) => ({ path: `${dir}/`, reason: "dependency-or-build-directory" as const })).sort(byPath),
  );
});

test("a .gitignore negation cannot re-include secrets or dependency directories", async () => {
  const root = await makeRepo({
    ".gitignore": "!.env\n!node_modules\n!node_modules/**\n!dist/\n!*.pem\n",
    ".env": "TOKEN=x\n",
    "node_modules/pkg/index.ts": "",
    "dist/out.ts": "",
    "keys/a.pem": "",
    "src/ok.ts": "",
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual([".gitignore", "src/ok.ts"]);
  expect(skipped).toEqual([
    { path: ".env", reason: "secret" },
    { path: "dist/", reason: "dependency-or-build-directory" },
    { path: "keys/a.pem", reason: "secret" },
    { path: "node_modules/", reason: "dependency-or-build-directory" },
  ]);
});

test("detects binary files by a NUL byte in the first 8 KiB only", async () => {
  const root = await makeRepo({
    "bin/early.dat": Buffer.from("text\0text"),
    "bin/late.txt": Buffer.concat([Buffer.alloc(8192, "a"), Buffer.from([0])]),
    "bin/empty.txt": "",
    "bin/text.txt": "plain\n",
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["bin/empty.txt", "bin/late.txt", "bin/text.txt"]);
  expect(skipped).toEqual([{ path: "bin/early.dat", reason: "binary" }]);
});

test("fails instead of ignoring an unreadable .gitignore", async () => {
  const root = await makeRepo({ ".gitignore": "hidden.ts\n", "hidden.ts": "" });
  await chmod(join(root, ".gitignore"), 0o000);
  await expect(scanRepository(root)).rejects.toThrow(/EACCES/);
});

test("a nested directory rule excludes the directory even when a deeper .gitignore negates its files", async () => {
  const root = await makeRepo({
    "src/.gitignore": "private/\n",
    "src/private/.gitignore": "!hidden.ts\n",
    "src/private/hidden.ts": "",
    "src/ok.ts": "",
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["src/.gitignore", "src/ok.ts"]);
  expect(skipped).toEqual([{ path: "src/private/", reason: "gitignored" }]);
});

test("secret files never reach a Jev candidate or the rendered output, even with a .ts extension", async () => {
  const token = "sk_live_FAKE0123456789abcdef";
  const leaky = (name: string) => `export function ${name}() {\n  return "${token}";\n}\n`;
  const root = await makeRepo({
    "secrets.ts": leaky("leak"),
    "credentials.ts": leaky("creds"),
    ".env": `API_TOKEN=${token}\n`,
    "src/app.ts": "export function run() {\n  return 1;\n}\n",
  });

  const seen: CodeChunk[] = [];
  const inner = fakeProvider({ fallback: 0.9 });
  const provider: DecisionProvider = {
    decide: (request) => {
      seen.push(...request.candidates);
      return inner.decide(request);
    },
  };

  for (const options of [{ provider }, { noJev: true }]) {
    const { result } = await runScope({ task: "return a value", repo: root, ...options });
    expect(result.chunks.map((s) => s.chunk.file)).toEqual(["src/app.ts"]);
    for (const text of [renderResult(result), JSON.stringify(result)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("secrets.ts");
      expect(text).not.toContain("credentials.ts");
    }
  }
  expect(seen.map((chunk) => chunk.file)).toEqual(["src/app.ts"]);
  expect(JSON.stringify(seen)).not.toContain(token);
});
