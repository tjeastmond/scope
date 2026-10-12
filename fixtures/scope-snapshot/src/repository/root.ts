import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.ts";

export interface RepositoryRoot {
  /** Absolute, symlinks resolved, no trailing slash. Everything is scanned and compared against this. */
  root: string;
  /** The path exactly as the caller gave it, for messages. */
  input: string;
}

/**
 * Resolves the repository to scan.
 *
 * Decision: the path given is exactly the root. Scope never walks up to an enclosing git root, so pointing it at a
 * subdirectory scans only that subdirectory. A symlinked repository path is resolved to its real path, so the
 * symlink-escape checks on files inside it compare against a real root.
 */
export function resolveRepository(path: string): RepositoryRoot {
  let root: string;
  let isDirectory: boolean;
  try {
    root = realpathSync(resolve(path));
    isDirectory = statSync(root).isDirectory();
  } catch {
    throw new UsageError(`--repo does not exist or is not accessible: ${path}`);
  }
  if (!isDirectory) throw new UsageError(`--repo is not a directory: ${path}`);
  return { root, input: path };
}

/**
 * The canonical repository-relative path: `/` separators, no leading `./`, no `..` segments. The on-disk spelling is
 * kept (no lowercasing, no Unicode normalization). Throws if the path is outside the root or is the root itself.
 */
export function toRepoPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Path is not inside the repository root: ${absolutePath}`);
  return rel.split(sep).join("/");
}
