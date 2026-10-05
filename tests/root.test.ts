import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { UsageError } from "../src/errors.ts";
import { resolveRepository, toRepoPath } from "../src/repository/root.ts";

let dir: string;
let real: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scope-root-"));
  real = await realpath(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("resolveRepository", () => {
  test("returns the absolute path for a nested directory, without walking up", async () => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "a", "b"), { recursive: true });
    const repo = resolveRepository(join(dir, "a", "b"));
    expect(repo.root).toBe(join(real, "a", "b"));
    expect(repo.input).toBe(join(dir, "a", "b"));
  });

  test("drops trailing slashes", () => {
    expect(resolveRepository(`${dir}///`).root).toBe(real);
  });

  test("resolves a relative path against the working directory", () => {
    expect(resolveRepository(relative(process.cwd(), dir)).root).toBe(real);
  });

  test("resolves a symlinked repository to its real path", async () => {
    const link = join(dir, "link");
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), link);
    expect(resolveRepository(link).root).toBe(join(real, "target"));
  });

  test("rejects a file", async () => {
    const file = join(dir, "f.ts");
    await writeFile(file, "");
    expect(() => resolveRepository(file)).toThrow(new UsageError(`--repo is not a directory: ${file}`));
  });

  test("rejects a missing path", () => {
    const missing = join(dir, "nope");
    expect(() => resolveRepository(missing)).toThrow(
      new UsageError(`--repo does not exist or is not accessible: ${missing}`),
    );
  });
});

describe("toRepoPath", () => {
  test("uses forward slashes with no leading ./", () => {
    expect(toRepoPath(real, join(real, "src", "a", "b.ts"))).toBe("src/a/b.ts");
    expect(toRepoPath(real, join(real, "x.ts"))).toBe("x.ts");
  });

  test("throws for paths outside the root, including sibling prefixes and the root itself", () => {
    expect(() => toRepoPath(real, join(real, "..", "other.ts"))).toThrow();
    expect(() => toRepoPath(join(real, "app"), join(real, "app2", "x.ts"))).toThrow();
    expect(() => toRepoPath(real, real)).toThrow();
  });

  test("preserves spaces, non-ASCII names and case", () => {
    expect(toRepoPath(real, join(real, "My Dir", "Café.ts"))).toBe("My Dir/Café.ts");
    expect(toRepoPath(real, join(real, "Src", "README.MD"))).toBe("Src/README.MD");
    const decomposed = "Café.ts";
    expect(toRepoPath(real, join(real, decomposed))).toBe(decomposed);
  });
});
