import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
