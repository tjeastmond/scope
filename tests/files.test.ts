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
