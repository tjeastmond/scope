// Content revision of a fixture: a sha256 over every file's repository-relative path and raw bytes.
// tasks/fixtures.lock.json pins one per fixture so labeled tasks cannot silently drift from the code they describe.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, LOCK_NAME, TASKS } from "./labels.ts";

export const LOCK_FILE = join(TASKS, LOCK_NAME);
const IGNORED_NAMES = new Set([".DS_Store"]);

async function listFiles(root: string, dir = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Hashes the sorted relative paths and raw file bytes (no newline normalization) of `fixtures/<fixture>`. */
export async function hashFixture(fixture: string, fixturesDir = FIXTURES): Promise<string> {
  const root = join(fixturesDir, fixture);
  const hash = createHash("sha256");
  for (const path of (await listFiles(root)).sort()) {
    const content = await readFile(join(root, path));
    hash.update(`${path}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readLock(lockFile = LOCK_FILE): Promise<Record<string, string>> {
  return JSON.parse(await readFile(lockFile, "utf8")) as Record<string, string>;
}
