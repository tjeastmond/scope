import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Major version of the store layout; the store directory is `store-v<STORE_MAJOR>`. */
export const STORE_MAJOR = 1;

export interface VersionKeys {
  store: number;
  scope: string;
  analyzer: string;
  treeSitter: string;
  grammars: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = extname(fileURLToPath(import.meta.url));
/** Modules outside `analyzers/` whose behaviour changes analysis results, relative to `src/` (or `dist/`). */
const EXTRA_MODULES = ["chunk-id", "repository/language", "repository/redact"];

/** Reads the version of the nearest package.json at or above `start` whose name is `name`. */
async function packageVersion(start: string, name: string): Promise<string> {
  let directory = start;
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (typeof pkg === "object" && pkg !== null && (pkg as { name?: unknown }).name === name) {
        const version = (pkg as { version?: unknown }).version;
        if (typeof version === "string" && version) return version;
        throw new Error(`package ${name} has no version`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`package ${name} not found`);
    directory = parent;
  }
}

async function analyzerFingerprint(): Promise<string> {
  const files = new Map<string, string>();
  for (const entry of await readdir(join(HERE, "..", "analyzers"), { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith(".map") && !entry.name.endsWith(".d.ts")) {
      files.set(`analyzers/${entry.name}`, join(HERE, "..", "analyzers", entry.name));
    }
  }
  for (const module of EXTRA_MODULES) files.set(`${module}${EXT}`, join(HERE, "..", `${module}${EXT}`));
  const hash = createHash("sha256");
  for (const relative of [...files.keys()].sort()) {
    hash
      .update(relative)
      .update("\0")
      .update(await readFile(files.get(relative)!))
      .update("\0");
  }
  return hash.digest("hex");
}

async function compute(): Promise<VersionKeys> {
  const require = createRequire(import.meta.url);
  // web-tree-sitter does not export its package.json, so resolve its entry point and walk up; the grammar packages
  // export their package.json.
  const dependency = (name: string, entry = name) => packageVersion(dirname(require.resolve(entry)), name);
  const [scope, analyzer, treeSitter, wasms, yaml] = await Promise.all([
    packageVersion(HERE, "scope"),
    analyzerFingerprint(),
    dependency("web-tree-sitter"),
    dependency("tree-sitter-wasms", "tree-sitter-wasms/package.json"),
    dependency("@tree-sitter-grammars/tree-sitter-yaml", "@tree-sitter-grammars/tree-sitter-yaml/package.json"),
  ]);
  return {
    store: STORE_MAJOR,
    scope,
    analyzer,
    treeSitter,
    grammars: { "tree-sitter-wasms": wasms, "@tree-sitter-grammars/tree-sitter-yaml": yaml },
  };
}

let memo: Promise<VersionKeys> | undefined;

/** The version keys of this process, computed once. Throws if a module or package cannot be read. */
export function currentVersionKeys(): Promise<VersionKeys> {
  memo ??= compute().catch((error) => {
    memo = undefined;
    throw error;
  });
  return memo;
}

let sdkMemo: Promise<string> | undefined;

/** The installed version of `@typesafe-ai/sdk`, read from its package.json. Throws if it cannot be read. */
export function sdkVersion(): Promise<string> {
  sdkMemo ??= (async () => {
    const name = "@typesafe-ai/sdk";
    return packageVersion(dirname(createRequire(import.meta.url).resolve(name)), name);
  })().catch((error) => {
    sdkMemo = undefined;
    throw error;
  });
  return sdkMemo;
}
