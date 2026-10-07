import { randomBytes } from "node:crypto";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CancelledError } from "../errors.ts";
import { scanRepository } from "../repository/files.ts";

/** `--output` cannot be honoured. A runtime failure (exit code 1), not a usage error. */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputError";
  }
}

export interface PreparedOutput {
  /** Writes the artifact to the target atomically; a cancelled `signal` leaves the target untouched. Cleans up after itself if it fails. */
  commit(text: string, signal?: AbortSignal): Promise<void>;
  /** Removes the temporary file if one exists. Safe to call at any point, any number of times. */
  discard(): Promise<void>;
}

const CAUSES: Record<string, string> = {
  ENOENT: "the directory does not exist",
  ENOTDIR: "a parent of the path is not a directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "the file system is read-only",
  EISDIR: "the path is a directory",
};

const cause = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  return (code && CAUSES[code]) ?? (error as Error).message;
};

/** The path with symlinks resolved: the file's own real path when it exists, else its parent's plus the file name. */
async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return join(await realpath(dirname(path)), basename(path));
  }
}

/**
 * Checks that `outputPath` is a safe destination and proves the directory is writable by creating the temporary file
 * the artifact will be written to, so a bad path fails before any (possibly paid) Jev request. The target must not be
 * a directory and, after resolving symlinks, must not be a file Scope would analyze (that would overwrite repository
 * source). Any other existing file, such as a previous output, may be replaced. `root` is the real repository root.
 */
export async function prepareOutput(root: string, outputPath: string): Promise<PreparedOutput> {
  const fail = (reason: string) => new OutputError(`cannot write --output ${outputPath}: ${reason}`);
  let target: string;
  try {
    target = await resolveTarget(resolve(outputPath));
    if ((await stat(target).catch(() => undefined))?.isDirectory()) throw fail("the path is a directory");
  } catch (error) {
    throw error instanceof OutputError ? error : fail(cause(error));
  }
  const inRepository = target.startsWith(`${root}${sep}`);
  /** Runs at preparation and again at commit: the run can take a while, and the repository may change meanwhile. */
  const assertNotSource = async () => {
    const { files, warnings } = await scanRepository(root);
    if (files.some((file) => join(root, file) === target)) {
      throw fail("it is a source file of the repository and would be overwritten");
    }
    // A truncated scan cannot show that an existing file inside the repository is not source, so it is refused.
    if (warnings.length > 0 && inRepository && (await stat(target).catch(() => undefined))?.isFile()) {
      throw fail("the repository scan was truncated, so it cannot be shown that this existing file is not source");
    }
  };
  await assertNotSource();

  const directory = dirname(target);
  // Short fixed prefix so a long destination name never overflows the file-name limit.
  const newTemp = () => join(directory, `.scope-${randomBytes(8).toString("hex")}.tmp`);
  // Proves the directory is writable now, then leaves nothing behind: a temporary file present during the run would
  // be scanned like any other file in the repository and could change what is selected.
  try {
    const probe = newTemp();
    await (await open(probe, "wx")).close();
    await rm(probe, { force: true });
  } catch (error) {
    throw fail(cause(error));
  }
  let tempPath: string | undefined;
  const discard = async () => {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
    tempPath = undefined;
  };
  return {
    discard,
    async commit(text, signal) {
      try {
        // A symlink swapped in along the path during the run would send the write somewhere the preflight never checked.
        if ((await resolveTarget(resolve(outputPath))) !== target) throw fail("the destination changed during the run");
        await assertNotSource();
        tempPath = newTemp();
        const handle = await open(tempPath, "wx");
        try {
          await handle.writeFile(text, "utf8");
        } finally {
          await handle.close();
        }
        // The last point a Ctrl-C can still leave the destination as it was.
        if (signal?.aborted) throw new CancelledError();
        await rename(tempPath, target);
        tempPath = undefined;
      } catch (error) {
        await discard();
        throw error instanceof OutputError || error instanceof CancelledError ? error : fail(cause(error));
      }
    },
  };
}
