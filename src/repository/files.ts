import { open, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Why a path was left out of the scan. Add members here as new eligibility rules arrive. */
export type SkipReason =
  "gitignored" | "secret" | "binary" | "unreadable" | "lockfile" | "minified" | "dependency-or-build-directory";

export interface SkippedPath {
  /** Repository-relative; directories skipped as a whole end in `/` and are not recursed into. */
  path: string;
  reason: SkipReason;
}

export interface ScanResult {
  /** Repository-relative, `/`-separated paths of eligible files, sorted. */
  files: string[];
  skipped: SkippedPath[];
}

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "coverage",
  "venv",
  ".venv",
  "__pycache__",
  ".scope",
]);

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "uv.lock",
]);

const MINIFIED = /\.min\.(js|css|mjs)$/;

/** Bytes read from the start of a file to decide whether it is binary. */
const SNIFF_BYTES = 8192;

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
  ".npmrc",
  ".netrc",
  "*.keystore",
]);

interface Rules {
  base: string;
  matcher: Ignore;
}

/** `posix.relative` drops the trailing slash that marks a directory, which `dir/` rules need to match. */
const relativeTo = (base: string, path: string) => posix.relative(base, path) + (path.endsWith("/") ? "/" : "");

/** Git precedence: rules from deeper `.gitignore` files override shallower ones; the last matching rule wins. */
function isIgnored(rules: readonly Rules[], path: string): boolean {
  let ignored = false;
  for (const { base, matcher } of rules) {
    const { ignored: hit, unignored } = matcher.test(base ? relativeTo(base, path) : path);
    if (hit) ignored = true;
    else if (unignored) ignored = false;
  }
  return ignored;
}

/** A NUL byte in the first 8 KiB marks binary content; only that prefix is ever read. Unreadable files are skipped. */
async function sniff(path: string): Promise<"binary" | "unreadable" | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return "unreadable";
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0) ? "binary" : undefined;
  } catch {
    return "unreadable";
  } finally {
    await handle.close();
  }
}

/** Reason a non-ignored-by-git file is excluded by name, or undefined when its name is fine. */
function nameSkipReason(name: string, path: string): SkipReason | undefined {
  if (secrets.ignores(path)) return "secret";
  if (LOCKFILES.has(name)) return "lockfile";
  if (MINIFIED.test(name)) return "minified";
  return undefined;
}

/**
 * Walks the repository and decides which files are eligible to be read and sent. Dependency and build directories
 * are never entered, `.gitignore` rules apply on the way down (a negation never re-includes secrets or the
 * built-in exclusions), and every excluded path is reported with a reason. Only binary sniffing reads file content.
 */
export async function scanRepository(root: string): Promise<ScanResult> {
  const files: string[] = [];
  const skipped: SkippedPath[] = [];
  const walk = async (directory: string, inherited: readonly Rules[]): Promise<void> => {
    const gitignore = await readFile(join(root, directory, ".gitignore"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        // Only a missing file means "no rules"; any other failure must not silently widen what is read.
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const rules = gitignore ? [...inherited, { base: directory, matcher: ignore().add(gitignore) }] : inherited;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const skip = (reason: SkipReason) => skipped.push({ path: entry.isDirectory() ? `${path}/` : path, reason });
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) skip("dependency-or-build-directory");
        else if (secrets.ignores(path)) skip("secret");
        else if (isIgnored(rules, `${path}/`)) skip("gitignored");
        else await walk(path, rules);
      } else if (entry.isFile()) {
        const reason = nameSkipReason(entry.name, path);
        if (reason) skip(reason);
        else if (isIgnored(rules, path)) skip("gitignored");
        else {
          const unusable = await sniff(join(root, path));
          if (unusable) skip(unusable);
          else files.push(path);
        }
      }
    }
  };
  await walk("", []);
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.sort(), skipped: skipped.sort(byPath) };
}
