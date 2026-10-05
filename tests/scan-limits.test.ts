import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_FILE_BYTES, MAX_SCAN_DEPTH } from "../src/config.ts";
import { scanRepository } from "../src/repository/files.ts";
import { runScope } from "../src/scope.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(tree: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scope-limits-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const code = "export const a = 1;\n";

test("a symlink loop is skipped instead of followed", async () => {
  const root = await makeDir({ "src/app.ts": code });
  await symlink("..", join(root, "src", "up"));
  const { files, skipped, warnings } = await scanRepository(root);
  expect(files).toEqual(["src/app.ts"]);
  expect(skipped).toEqual([{ path: "src/up/", reason: "symlink-loop" }]);
  expect(warnings).toEqual([]);
});

test("symlinks that leave the repository are skipped, for directories and files alike", async () => {
  const outside = await makeDir({ "leak.ts": code, "sub/deep.ts": code });
  const root = await makeDir({ "src/app.ts": code });
  await symlink("/etc", join(root, "etc-link"));
  await symlink(outside, join(root, "outside-dir"));
  await symlink(join(outside, "leak.ts"), join(root, "leak.ts"));
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["src/app.ts"]);
  expect(skipped).toEqual([
    { path: "etc-link/", reason: "symlink-outside-repository" },
    { path: "leak.ts", reason: "symlink-outside-repository" },
    { path: "outside-dir/", reason: "symlink-outside-repository" },
  ]);
});

test("symlinks inside the repository are skipped, so an alias cannot dodge the exclusions on its target", async () => {
  const root = await makeDir({
    "lib/util.ts": code,
    "credentials.ts": code,
    "secrets/.env": "KEY=1\n",
    "secrets/note.ts": code,
    ".gitignore": "generated.ts\n",
    "generated.ts": code,
  });
  await symlink("lib", join(root, "alias"));
  await symlink("lib/util.ts", join(root, "util-link.ts"));
  await symlink("credentials.ts", join(root, "config.ts"));
  await symlink("secrets", join(root, "shared"));
  await symlink("generated.ts", join(root, "gen-link.ts"));
  await symlink("missing", join(root, "broken"));
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual([".gitignore", "lib/util.ts"]);
  expect(skipped.filter(({ reason }) => reason === "symlink")).toEqual([
    { path: "alias/", reason: "symlink" },
    { path: "config.ts", reason: "symlink" },
    { path: "gen-link.ts", reason: "symlink" },
    { path: "shared/", reason: "symlink" },
    { path: "util-link.ts", reason: "symlink" },
  ]);
  expect(skipped).toContainEqual({ path: "broken", reason: "unreadable" });
});

test("an oversized .gitignore fails the scan instead of being read or ignored", async () => {
  const root = await makeDir({ ".gitignore": "*.log\n".repeat(50), "app.ts": code });
  await expect(scanRepository(root, { maxFileBytes: 100 })).rejects.toThrow("larger than 100 bytes");
});

test("a symlinked .gitignore contributes no rules", async () => {
  const outside = await makeDir({ rules: "*.ts\n" });
  const root = await makeDir({ "app.ts": code });
  await symlink(join(outside, "rules"), join(root, ".gitignore"));
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["app.ts"]);
  expect(skipped).toEqual([{ path: ".gitignore", reason: "symlink-outside-repository" }]);
});

test("a symlink to the parent of the root, to its own directory or to an ancestor is never followed", async () => {
  const holder = await makeDir({ "repo/lib/util.ts": code });
  const root = join(holder, "repo");
  await symlink("..", join(root, "parent"));
  await symlink(".", join(root, "lib", "self"));
  await symlink("..", join(root, "lib", "up"));
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["lib/util.ts"]);
  expect(skipped).toEqual([
    { path: "lib/self/", reason: "symlink-loop" },
    { path: "lib/up/", reason: "symlink-loop" },
    { path: "parent/", reason: "symlink-outside-repository" },
  ]);
});

test("a symlinked --repo root still scans its contents", async () => {
  const real = await makeDir({ "app.ts": code });
  const holder = await makeDir();
  await symlink(real, join(holder, "link"));
  expect((await scanRepository(join(holder, "link"))).files).toEqual(["app.ts"]);
});

test("a file over the size limit is skipped, one exactly at the limit is kept", async () => {
  const root = await makeDir({
    "big.ts": "x".repeat(MAX_FILE_BYTES + 1),
    "edge.ts": "x".repeat(MAX_FILE_BYTES),
    "small.ts": code,
  });
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["edge.ts", "small.ts"]);
  expect(skipped).toEqual([{ path: "big.ts", reason: "too-large" }]);
});

test.skipIf(process.getuid?.() === 0)("an unreadable directory is skipped and the scan continues", async () => {
  const root = await makeDir({ "locked/inner.ts": code, "ok.ts": code });
  await chmod(join(root, "locked"), 0o000);
  try {
    const { files, skipped } = await scanRepository(root);
    expect(files).toEqual(["ok.ts"]);
    expect(skipped).toEqual([{ path: "locked/", reason: "unreadable" }]);
  } finally {
    await chmod(join(root, "locked"), 0o755);
  }
});

test.skipIf(process.getuid?.() === 0)("an unreadable file is skipped with a reason", async () => {
  const root = await makeDir({ "locked.ts": code, "ok.ts": code });
  await chmod(join(root, "locked.ts"), 0o000);
  const { files, skipped } = await scanRepository(root);
  expect(files).toEqual(["ok.ts"]);
  expect(skipped).toEqual([{ path: "locked.ts", reason: "unreadable" }]);
});

test("directories past the depth limit are not entered and the scan warns", async () => {
  const root = await makeDir({ "a/b/c/d.ts": code, "a/b/ok.ts": code, "top.ts": code, "z/y/x/w.ts": code });
  const { files, warnings } = await scanRepository(root, { maxDepth: 2 });
  expect(files).toEqual(["a/b/ok.ts", "top.ts"]);
  expect(warnings).toEqual(["Directories nested deeper than 2 levels were not scanned (first: a/b/c/)."]);
  expect(warnings).toHaveLength(1);
  const exactly = await scanRepository(root, { maxDepth: 3 });
  expect(exactly.files).toContain("a/b/c/d.ts");
  expect(exactly.warnings).toEqual([]);
});

test("the file-count limit truncates in sorted order and warns", async () => {
  const root = await makeDir({
    "d/z.ts": code,
    "d/zz.ts": code,
    "e.ts": code,
    "a.ts": code,
    "b.ts": code,
    "c.ts": code,
  });
  const first = await scanRepository(root, { maxFiles: 3 });
  expect(first.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  expect(first.warnings).toEqual(["Scan stopped at 3 files; the rest were not scanned."]);
  expect(await scanRepository(root, { maxFiles: 3 })).toEqual(first);
  expect((await scanRepository(root, { maxFiles: 6 })).warnings).toEqual([]);
});

test("the total-bytes limit truncates and warns", async () => {
  const root = await makeDir({ "a.ts": "x".repeat(40), "b.ts": "x".repeat(40), "c.ts": "x".repeat(10) });
  const { files, warnings } = await scanRepository(root, { maxTotalBytes: 80 });
  expect(files).toEqual(["a.ts", "b.ts"]);
  expect(warnings).toEqual(["Scan stopped at 80 bytes of source; the rest was not scanned."]);
  expect((await scanRepository(root, { maxTotalBytes: 90 })).warnings).toEqual([]);
});

test("a truncation warning surfaces in the run result", async () => {
  const deep = Array.from({ length: MAX_SCAN_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
  const repo = await makeDir({ "app.ts": code, [`${deep}/hidden.ts`]: code });
  const { result } = await runScope({ task: "anything", repo, noJev: true });
  expect(result.warnings).toEqual([expect.stringContaining(`deeper than ${MAX_SCAN_DEPTH} levels`)]);
  expect(result.chunks.map((c) => c.chunk.file)).toEqual(["app.ts"]);
});

test("an analyzer's syntax-error warning surfaces in the run result", async () => {
  const repo = await makeDir({ "broken.ts": "export const a = 1;\nfunction ( {\n", "ok.ts": code });
  const { result } = await runScope({ task: "anything", repo, noJev: true });
  expect(result.warnings).toEqual([
    expect.stringContaining("broken.ts: syntax errors; extracted 1 declarations"),
    expect.stringContaining("broken.ts: syntax errors; text fallback"),
  ]);
});
