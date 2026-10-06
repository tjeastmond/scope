import { posix } from "node:path";
import type { ImportResolution, ImportResolver } from "./types.ts";

const ECMASCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
/** ESM TypeScript writes the emitted extension in the specifier while the source has the TypeScript one. */
const EMITTED_TO_SOURCE: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const ALIAS = /^(@\/|~|#)/;

const unresolved = (reason: string): ImportResolution => ({ unresolved: reason });
const missing = (path: string) => unresolved(`no such file in the scanned repository: ${path}`);
const escapes = () => unresolved("escapes the repository root");

/** First candidate that is a scanned file, with how it was found. */
function firstKnown(
  known: ReadonlySet<string>,
  candidates: readonly (readonly [string, string])[],
): ImportResolution | undefined {
  const hit = candidates.find(([path]) => known.has(path));
  return hit ? { file: hit[0], via: hit[1] } : undefined;
}

function resolveEcmascript(known: ReadonlySet<string>, file: string, specifier: string): ImportResolution {
  if (!/^\.\.?(\/|$)/.test(specifier)) {
    return unresolved(
      ALIAS.test(specifier) ? "path alias or bare specifier not resolved in V1" : "bare package specifier",
    );
  }
  const target = posix.join(posix.dirname(file), specifier).replace(/\/$/, "");
  if (target === ".." || target.startsWith("../")) return escapes();
  const extension = posix.extname(target);
  const stripped = target.slice(0, target.length - extension.length);
  return (
    firstKnown(known, [
      [target, "exact path"],
      ...(EMITTED_TO_SOURCE[extension] ?? []).map(
        (ext) => [stripped + ext, `${extension} specifier mapped to ${ext} source`] as const,
      ),
      ...ECMASCRIPT_EXTENSIONS.map((ext) => [target + ext, `extension ${ext} appended`] as const),
      ...ECMASCRIPT_EXTENSIONS.map((ext) => [posix.join(target, `index${ext}`), "index file"] as const),
    ]) ?? missing(target)
  );
}

/** `a/b` as `a/b.py` or the package `a/b/__init__.py`. */
function pythonModule(known: ReadonlySet<string>, base: string): ImportResolution | undefined {
  return firstKnown(known, [
    [`${base}.py`, "module file"],
    [posix.join(base, "__init__.py"), "package __init__"],
  ]);
}

function resolvePython(known: ReadonlySet<string>, file: string, specifier: string): ImportResolution {
  const [, dots = "", dotted = ""] = /^(\.*)(.*)$/.exec(specifier)!;
  const parts = dotted.split(".").filter(Boolean);
  if (dots) {
    // One dot is the importer's package; each further dot goes one directory up.
    const directory = posix.join(posix.dirname(file), ...Array(dots.length - 1).fill(".."));
    if (directory === ".." || directory.startsWith("../")) return escapes();
    const base = posix.join(directory, ...parts);
    if (parts.length === 0) {
      const init = posix.join(base, "__init__.py");
      return known.has(init) ? { file: init, via: "package __init__" } : missing(init);
    }
    return pythonModule(known, base) ?? missing(`${base}.py`);
  }
  // Absolute: a local module relative to the repository root or to the importer's top-level directory.
  const top = file.includes("/") ? file.split("/")[0]! : undefined;
  for (const root of [".", ...(top ? [top] : [])]) {
    const found = pythonModule(known, posix.join(root, ...parts));
    if (found) return found;
  }
  return unresolved(`no local module for "${specifier}" (external packages are not resolved)`);
}

/**
 * Resolves relative imports (and Python local modules) against the scanned files, with POSIX paths, and never leaves
 * the repository. Aliases, bare packages, package `exports` and bundler resolution are unresolved, with a reason.
 */
export function createImportResolver(files: Iterable<string>): ImportResolver {
  const known = new Set(files);
  return ({ file, language }, specifier) => {
    if (language === "typescript" || language === "javascript") return resolveEcmascript(known, file, specifier);
    if (language === "python") return resolvePython(known, file, specifier);
    return unresolved(`import resolution is not supported for ${language}`);
  };
}
