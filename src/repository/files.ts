import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Files that commonly hold credentials. They are never read, so they can never reach Jev. */
const SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "*secret*", "*credential*"];

async function readIgnore(root: string) {
  const matcher = ignore().add(SECRET_PATTERNS);
  const gitignore = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  return matcher.add(gitignore);
}

/**
 * Repository-relative, `/`-separated paths of files with one of `extensions`, in sorted order. Skips dependency
 * and build directories, files matched by the root `.gitignore`, and files that look like secrets.
 */
export async function listFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const excluded = await readIgnore(root);
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !excluded.ignores(`${path}/`)) await walk(path);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) && !excluded.ignores(path)) {
        files.push(path);
      }
    }
  };
  await walk("");
  return files.sort();
}
