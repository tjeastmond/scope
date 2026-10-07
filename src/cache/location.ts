import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DocumentStore, type CommitOutcome, type DocumentType, type Transaction } from "./store.ts";
import { STORE_MAJOR, currentVersionKeys, type VersionKeys } from "./versions.ts";

/** Name of the cache directory inside the repository root. */
export const CACHE_DIR = ".scope";

interface Meta {
  root: string;
  keys: VersionKeys;
  lastUsed: number;
}

const isMeta = (payload: unknown): payload is Meta => {
  const meta = payload as Partial<Meta> | null;
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof meta.root === "string" &&
    typeof meta.keys === "object" &&
    meta.keys !== null &&
    typeof meta.lastUsed === "number"
  );
};
const metaType: DocumentType<Meta> = { name: "meta", schemaVersion: 1, validate: isMeta };

export interface RepositoryCache {
  store: DocumentStore;
  /** `<repoRoot>/.scope/store-v<STORE_MAJOR>`. */
  directory: string;
  /** Real path of the repository root. */
  root: string;
  keys: VersionKeys;
  /** True when the store has no usable meta or its root or keys differ: source-analysis data must be rebuilt. */
  fresh: boolean;
}

const isStale = (meta: Meta | undefined, current: { root: string; keys: VersionKeys }) =>
  meta === undefined || meta.root !== current.root || !isDeepStrictEqual(meta.keys, current.keys);

/**
 * Throws unless `path` is missing or a real directory. `.scope` and the store directory come from the repository,
 * which is untrusted: a symlink there could point the cache's writes and removals at an unrelated directory.
 */
async function assertNotLinked(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error(`${path} is not a directory (symlinks are not followed)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const oneLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

/**
 * Opens the store of a repository at `<repoRoot>/.scope/store-v<N>`. There are no partitions: the directory lives
 * inside the repository, so two repositories never share a store, and a copied or moved repository is detected
 * because the root recorded in `meta.json` differs from its real path. Reads only; never throws.
 */
export async function openRepositoryCache(
  repoRoot: string,
  options: { keys?: VersionKeys } = {},
): Promise<{ cache?: RepositoryCache; warnings: string[] }> {
  try {
    const root = await realpath(repoRoot);
    const keys = options.keys ?? (await currentVersionKeys());
    const directory = join(root, CACHE_DIR, `store-v${STORE_MAJOR}`);
    await assertNotLinked(join(root, CACHE_DIR));
    await assertNotLinked(directory);
    const store = new DocumentStore(directory);
    const { value, warning } = await store.read(metaType);
    const fresh = isStale(value, { root, keys });
    return { cache: { store, directory, root, keys, fresh }, warnings: warning ? [warning] : [] };
  } catch (error) {
    return { warnings: [`cache disabled: ${oneLine(error)}`] };
  }
}

/** Creates `.scope/.gitignore` (`*`) when missing so git ignores the cache. Never touches any other .gitignore. */
async function ensureGitignore(root: string): Promise<void> {
  const directory = join(root, CACHE_DIR);
  await assertNotLinked(directory);
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(join(directory, ".gitignore"), "wx");
    try {
      await handle.writeFile("*\n", "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Commits changes to the repository store. When the meta on disk (re-read under the lock) is missing or its root or keys
 * differ, every document except `meta` is removed first,
 * then `update` runs, then `meta` is written with `lastUsed`. Store directories of other majors (`store-v<other>`) are
 * left untouched, since an older Scope may still use them. File system errors degrade to `committed: false`.
 */
export async function commitRepositoryCache(
  cache: RepositoryCache,
  update?: (tx: Transaction) => Promise<void> | void,
  options: { now?: number } = {},
): Promise<CommitOutcome> {
  try {
    await ensureGitignore(cache.root);
    await assertNotLinked(cache.directory);
  } catch (error) {
    return { committed: false, warning: `cache not written: ${oneLine(error)}` };
  }
  try {
    return await cache.store.commit(async (tx) => {
      // Re-check under the lock: `.scope` or the store directory may have been replaced while the lock was awaited.
      // (Node has no openat/unlinkat, so a process rewriting the repository during the commit itself is out of reach.)
      if ((await realpath(cache.directory)) !== cache.directory) {
        throw new Error(`${cache.directory} is not a directory (symlinks are not followed)`);
      }
      // Decide under the lock, from the meta on disk: another run may have committed other keys since open.
      if (isStale(await tx.read(metaType), cache)) {
        for (const name of await tx.list()) if (name !== metaType.name) tx.removeName(name);
      }
      await update?.(tx);
      tx.write(metaType, { root: cache.root, keys: cache.keys, lastUsed: options.now ?? Date.now() });
    });
  } catch (error) {
    return { committed: false, warning: `cache not written: ${oneLine(error)}` };
  }
}
