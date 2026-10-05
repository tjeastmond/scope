import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_FILE_BYTES } from "../src/config.ts";
import { scanRepository } from "../src/repository/files.ts";

const dirs: string[] = [];
const unreadable: string[] = [];
afterEach(async () => {
  // Restore permissions first so the recursive removal can delete the locked file.
  await Promise.all(unreadable.splice(0).map((path) => chmod(path, 0o644).catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(tree: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scope-fixtures-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** A mixed repository covering every skip reason at once, so the inventory is asserted exactly. */
async function makeMixedRepo(): Promise<string> {
  const outside = await makeDir({ "leak.ts": "export const leaked = 1;\n" });
  const root = await makeDir({
    ".gitignore": "*.log\ncache/\n",
    "README.md": "# Mixed\n",
    "package.json": '{ "name": "mixed" }\n',
    "bun.lock": "{}\n",
    ".env": "API_KEY=abc\n",
    "debug.log": "noise\n",
    "cache/blob.txt": "cached\n",
    "src/.gitignore": "generated/\n*.tmp\n",
    "src/index.ts": "export const main = 1;\n",
    "src/util/math.ts": "export const add = (a: number, b: number) => a + b;\n",
    "src/generated/api.ts": "export const generated = 1;\n",
    "src/scratch.tmp": "scratch\n",
    "src/private.ts": "export const hidden = 1;\n",
    "public/app.min.js": "var a=1;",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    "docs/huge.txt": "x".repeat(MAX_FILE_BYTES + 1),
    "dist/bundle.js": "var bundle = 1;\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
  });
  await chmod(join(root, "src/private.ts"), 0o000);
  unreadable.push(join(root, "src/private.ts"));
  await symlink("index.ts", join(root, "src/alias.ts"));
  await symlink("..", join(root, "src/up"));
  await symlink(join(outside, "leak.ts"), join(root, "leak.ts"));
  return root;
}

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Every entry's type, mode and content hash (symlinks by target); the locked file is hashed by mode alone. */
async function snapshot(root: string, directory = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(join(root, directory))) {
    const path = directory ? `${directory}/${name}` : name;
    const full = join(root, path);
    const info = await lstat(full);
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isSymbolicLink()) result[path] = `link ${await readlink(full)}`;
    else if (info.isDirectory()) Object.assign(result, { [path]: `dir ${mode}` }, await snapshot(root, path));
    else result[path] = `file ${mode} ${(info.mode & 0o400) === 0 ? "locked" : await sha256(full)}`;
  }
  return result;
}

test("the mixed repository yields the exact eligible and skipped inventory", async () => {
  const root = await makeMixedRepo();
  const { files, skipped, warnings } = await scanRepository(root);
  expect(files).toEqual([
    ".gitignore",
    "README.md",
    "package.json",
    "src/.gitignore",
    "src/index.ts",
    "src/util/math.ts",
  ]);
  expect(skipped).toEqual([
    { path: ".env", reason: "secret" },
    { path: "assets/logo.png", reason: "binary" },
    { path: "bun.lock", reason: "lockfile" },
    { path: "cache/", reason: "gitignored" },
    { path: "debug.log", reason: "gitignored" },
    { path: "dist/", reason: "dependency-or-build-directory" },
    { path: "docs/huge.txt", reason: "too-large" },
    { path: "leak.ts", reason: "symlink-outside-repository" },
    { path: "node_modules/", reason: "dependency-or-build-directory" },
    { path: "public/app.min.js", reason: "minified" },
    { path: "src/alias.ts", reason: "symlink" },
    { path: "src/generated/", reason: "gitignored" },
    { path: "src/private.ts", reason: "unreadable" },
    { path: "src/scratch.tmp", reason: "gitignored" },
    { path: "src/up/", reason: "symlink-loop" },
  ]);
  expect(warnings).toEqual([]);
});

test("scanning neither modifies nor creates anything in the repository, and repeats exactly", async () => {
  const root = await makeMixedRepo();
  const before = await snapshot(root);
  const first = await scanRepository(root);
  const second = await scanRepository(root);
  expect(second).toEqual(first);
  expect(await snapshot(root)).toEqual(before);
});
