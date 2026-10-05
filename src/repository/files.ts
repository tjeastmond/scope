import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Repository-relative, `/`-separated paths of files with one of `extensions`, in sorted order. */
export async function listFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep))
    .filter((parts) => !parts.some((part) => SKIPPED_DIRECTORIES.has(part)))
    .map((parts) => parts.join("/"))
    .sort();
}
