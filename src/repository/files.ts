import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import ignore, { type Ignore } from "ignore";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Files that commonly hold credentials. A separate matcher, so no `.gitignore` negation can re-include them. */
const secrets = ignore().add([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "*secret*",
  "*credential*",
]);

interface Rules {
  base: string;
  matcher: Ignore;
}

/** Git precedence: rules from deeper `.gitignore` files override shallower ones; the last matching rule wins. */
function isIgnored(rules: readonly Rules[], path: string): boolean {
  let ignored = false;
  for (const { base, matcher } of rules) {
    const { ignored: hit, unignored } = matcher.test(base ? posix.relative(base, path) : path);
    if (hit) ignored = true;
    else if (unignored) ignored = false;
  }
  return ignored;
}

/**
 * Repository-relative, `/`-separated paths of files with one of `extensions`, in sorted order. Skips dependency
 * and build directories, files matched by any `.gitignore` on the way down, and files that look like secrets.
 */
export async function listFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, inherited: readonly Rules[]): Promise<void> => {
    const gitignore = await readFile(join(root, directory, ".gitignore"), "utf8").catch(() => "");
    const rules = gitignore ? [...inherited, { base: directory, matcher: ignore().add(gitignore) }] : inherited;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (secrets.ignores(path)) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !isIgnored(rules, `${path}/`)) await walk(path, rules);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) && !isIgnored(rules, path)) {
        files.push(path);
      }
    }
  };
  await walk("", []);
  return files.sort();
}
