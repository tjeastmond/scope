import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles } from "../src/repository/files.ts";

test("lists matching files sorted, with / separators, skipping excluded directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  try {
    for (const dir of ["src/b", "src/a", "node_modules/x", ".git"]) await mkdir(join(root, dir), { recursive: true });
    for (const file of ["src/b/two.ts", "src/a/one.tsx", "src/a/notes.md", "node_modules/x/skip.ts", ".git/skip.ts"]) {
      await writeFile(join(root, file), "");
    }
    expect(await listFiles(root, [".ts", ".tsx"])).toEqual(["src/a/one.tsx", "src/b/two.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes .gitignore matches and secret-looking files so they are never read or sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  try {
    for (const dir of ["src", "private", "keys"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, ".gitignore"), "private/\n*.generated.ts\n");
    for (const file of [
      "src/ok.ts",
      "src/api.generated.ts",
      "private/internal.ts",
      "src/credentials.ts",
      "keys/server.key",
      "src/secrets.ts",
    ]) {
      await writeFile(join(root, file), "");
    }
    expect(await listFiles(root, [".ts", ".key"])).toEqual(["src/ok.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret exclusions survive .gitignore negations, and nested .gitignore files apply with deeper rules winning", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  try {
    await mkdir(join(root, "src/deep"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "!credentials.ts\n!src/secrets.ts\n*.skip.ts\n");
    await writeFile(join(root, "src/.gitignore"), "private.ts\n!keep.skip.ts\n");
    await writeFile(join(root, "src/deep/.gitignore"), "/local.ts\n");
    for (const file of [
      "credentials.ts",
      "src/secrets.ts",
      "src/private.ts",
      "src/ok.ts",
      "src/keep.skip.ts",
      "src/drop.skip.ts",
      "src/deep/local.ts",
      "src/deep/private.ts",
      "src/deep/fine.ts",
      "private.ts",
    ]) {
      await writeFile(join(root, file), "");
    }
    expect(await listFiles(root, [".ts"])).toEqual(["private.ts", "src/deep/fine.ts", "src/keep.skip.ts", "src/ok.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails instead of ignoring an unreadable .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  try {
    await writeFile(join(root, ".gitignore"), "hidden.ts\n");
    await writeFile(join(root, "hidden.ts"), "");
    await chmod(join(root, ".gitignore"), 0o000);
    await expect(listFiles(root, [".ts"])).rejects.toThrow(/EACCES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a nested directory rule excludes the directory even when a deeper .gitignore negates its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-files-"));
  try {
    await mkdir(join(root, "src/private"), { recursive: true });
    await writeFile(join(root, "src/.gitignore"), "private/\n");
    await writeFile(join(root, "src/private/.gitignore"), "!hidden.ts\n");
    await writeFile(join(root, "src/private/hidden.ts"), "");
    await writeFile(join(root, "src/ok.ts"), "");
    expect(await listFiles(root, [".ts"])).toEqual(["src/ok.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
