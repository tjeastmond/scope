import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { CancelledError } from "../errors.ts";
import { MAX_FILE_BYTES, MAX_SCAN_BYTES, MAX_SCAN_DEPTH, MAX_SCAN_FILES } from "../config.ts";

/** Why a path was left out of the scan. Add members here as new eligibility rules arrive. */
export type SkipReason =
  | "gitignored"
  | "secret"
  | "binary"
  | "unreadable"
  | "lockfile"
  | "minified"
  | "dependency-or-build-directory"
  | "too-large"
  | "symlink-outside-repository"
  | "symlink-loop"
  | "symlink";

export interface SkippedPath {
  /** Repository-relative; directories skipped as a whole end in `/` and are not recursed into. */
  path: string;
  reason: SkipReason;
}

export interface ScanResult {
  /** Repository-relative, `/`-separated paths of eligible files, sorted. */
  files: string[];
  skipped: SkippedPath[];
  /** One message per limit that truncated the scan; surfaced in `ScopeResult.warnings`. */
  warnings: string[];
}

export interface ScanLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxDepth: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ScanLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_SCAN_FILES,
  maxDepth: MAX_SCAN_DEPTH,
  maxTotalBytes: MAX_SCAN_BYTES,
};

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

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** Reads a `.gitignore`, refusing one over the size limit: dropping its rules would silently un-ignore files. */
async function readIgnoreFile(path: string, maxBytes: number): Promise<string> {
  if ((await stat(path)).size > maxBytes)
    throw new Error(`${path} is larger than ${maxBytes} bytes; refusing to scan.`);
  return readFile(path, "utf8");
}

/**
 * Walks the repository and decides which files are eligible to be read and sent. Dependency and build directories
 * are never entered, `.gitignore` rules apply on the way down (a negation never re-includes secrets or the
 * built-in exclusions), and every excluded path is reported with a reason. Entries are visited in sorted order, so a
 * limit truncates the same way on every run. Symlinks are never followed: the target of an in-repository link is
 * scanned under its own path, and following the alias would let it dodge the secret, `.gitignore` and directory
 * exclusions that apply to the target. Only binary sniffing reads file content.
 */
export async function scanRepository(
  root: string,
  overrides: Partial<ScanLimits> = {},
  signal?: AbortSignal,
): Promise<ScanResult> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const realRoot = await realpath(root);
  const files: string[] = [];
  const skipped: SkippedPath[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let stopped = false;
  let tooDeep: string | undefined;
  const stop = (message: string) => {
    stopped = true;
    warnings.push(message);
  };
  const walk = async (directory: string, inherited: readonly Rules[]) => {
    const skipDirectory = (reason: SkipReason) => skipped.push({ path: `${directory}/`, reason });
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => undefined);
    if (!entries) return skipDirectory("unreadable");
    // Only a regular `.gitignore` counts: a symlinked one could pull in rules from outside the repository.
    const gitignore = entries.some((entry) => entry.name === ".gitignore" && entry.isFile())
      ? await readIgnoreFile(join(root, directory, ".gitignore"), limits.maxFileBytes)
      : "";
    const rules = gitignore ? [...inherited, { base: directory, matcher: ignore().add(gitignore) }] : inherited;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // A Ctrl-C stops the traversal itself, not just the work after it, so a large repository is not walked to the end.
      if (signal?.aborted) throw new CancelledError();
      if (stopped) return;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      const skip = (reason: SkipReason) => skipped.push({ path: isDirectory ? `${path}/` : path, reason });
      if (entry.isSymbolicLink()) {
        const resolved = await Promise.all([realpath(join(root, path)), stat(join(root, path))]).catch(() => undefined);
        if (!resolved) {
          skip("unreadable");
          continue;
        }
        const [target, info] = resolved;
        isDirectory = info.isDirectory();
        if (!isInside(realRoot, target)) skip("symlink-outside-repository");
        else if (isDirectory && isInside(target, join(realRoot, directory))) skip("symlink-loop");
        else skip("symlink");
        continue;
      }
      const isFile = entry.isFile();
      if (isDirectory) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) skip("dependency-or-build-directory");
        else if (secrets.ignores(path)) skip("secret");
        else if (isIgnored(rules, `${path}/`)) skip("gitignored");
        else if (path.split("/").length > limits.maxDepth) tooDeep ??= path;
        else await walk(path, rules);
      } else if (entry.name === ".git") {
        // Worktrees and submodules keep a regular `.git` metadata file.
        skip("dependency-or-build-directory");
      } else if (isFile) {
        const reason = nameSkipReason(entry.name, path);
        if (reason) skip(reason);
        else if (isIgnored(rules, path)) skip("gitignored");
        else {
          const size = (await stat(join(root, path)).catch(() => undefined))?.size;
          const unusable =
            size === undefined
              ? "unreadable"
              : size > limits.maxFileBytes
                ? "too-large"
                : await sniff(join(root, path));
          if (unusable) skip(unusable);
          else if (files.length >= limits.maxFiles)
            stop(`Scan stopped at ${limits.maxFiles} files; the rest were not scanned.`);
          else if (totalBytes + (size ?? 0) > limits.maxTotalBytes)
            stop(`Scan stopped at ${limits.maxTotalBytes} bytes of source; the rest was not scanned.`);
          else {
            totalBytes += size ?? 0;
            files.push(path);
          }
        }
      }
    }
  };
  await walk("", []);
  if (tooDeep)
    warnings.push(`Directories nested deeper than ${limits.maxDepth} levels were not scanned (first: ${tooDeep}/).`);
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.sort(), skipped: skipped.sort(byPath), warnings };
}
