import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentStore, type DocumentType } from "../src/cache/store.ts";

interface Files {
  items: string[];
}
const isFiles = (payload: unknown): payload is Files =>
  typeof payload === "object" && payload !== null && Array.isArray((payload as Files).items);
const files: DocumentType<Files> = { name: "files", schemaVersion: 2, validate: isFiles };

let dir: string;
let store: DocumentStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scope-store-test-"));
  store = new DocumentStore(dir);
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const docPath = (name = "files") => join(dir, `${name}.json`);
const put = (value: Files = { items: ["a"] }) => store.commit((tx) => tx.write(files, value));

describe("read and write", () => {
  test("round trips a document", async () => {
    expect(await put({ items: ["a", "b"] })).toEqual({ committed: true });
    expect(await store.read(files)).toEqual({ value: { items: ["a", "b"] } });
    expect(JSON.parse(await readFile(docPath(), "utf8"))).toEqual({ schemaVersion: 2, items: ["a", "b"] });
  });

  test("a missing document is empty without a warning", async () => {
    expect(await store.read(files)).toEqual({ value: undefined });
  });

  test("creates the directory lazily", async () => {
    const nested = new DocumentStore(join(dir, "a", "b"));
    expect(await nested.read(files)).toEqual({ value: undefined });
    expect((await nested.commit((tx) => tx.write(files, { items: [] }))).committed).toBe(true);
    expect((await nested.read(files)).value).toEqual({ items: [] });
  });

  test("remove deletes a document", async () => {
    await put();
    await store.commit((tx) => tx.remove(files));
    expect(await store.read(files)).toEqual({ value: undefined });
  });

  test("rejects invalid names and non-object payloads", async () => {
    await expect(store.read({ ...files, name: "../x" })).rejects.toThrow("invalid document name");
    await expect(store.commit((tx) => tx.write(files, [] as unknown as Files))).rejects.toThrow("plain object");
  });
});

describe("unusable documents read as empty with a warning", () => {
  const expectWarning = async () => {
    const outcome = await store.read(files);
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("files.json");
    expect(outcome.warning).not.toContain("\n");
  };

  test("invalid JSON", async () => {
    await writeFile(docPath(), "not json");
    await expectWarning();
  });

  test("truncated file", async () => {
    await put({ items: ["alpha", "beta", "gamma"] });
    await truncate(docPath(), Math.floor((await stat(docPath())).size / 2));
    await expectWarning();
  });

  test("not an object", async () => {
    await writeFile(docPath(), "[1,2]");
    await expectWarning();
  });

  test("newer schemaVersion", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 3, items: [] }));
    await expectWarning();
  });

  test("missing schemaVersion", async () => {
    await writeFile(docPath(), JSON.stringify({ items: [] }));
    await expectWarning();
  });

  test("non-integer schemaVersion", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1.5, items: [] }));
    await expectWarning();
  });

  test("failed shape check", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 2, items: "nope" }));
    await expectWarning();
  });

  test("older version without a migration", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1, items: [] }));
    await expectWarning();
  });

  test("an older version is migrated when the type can", async () => {
    const migrating: DocumentType<Files> = {
      ...files,
      migrate: (from, payload) => (from === 1 ? { items: (payload as { names: string[] }).names } : undefined),
    };
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1, names: ["x"] }));
    expect(await store.read(migrating)).toEqual({ value: { items: ["x"] } });
  });

  test("a migration that discards yields a warning", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1, items: [] }));
    const outcome = await store.read({ ...files, migrate: () => undefined });
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("files.json");
  });

  test("the next commit replaces a corrupt document", async () => {
    await writeFile(docPath(), "{");
    await put({ items: ["fresh"] });
    expect(await store.read(files)).toEqual({ value: { items: ["fresh"] } });
  });
});

describe("commit", () => {
  test("staged writes are not visible if update throws, and the lock is released", async () => {
    await put({ items: ["old"] });
    await expect(
      store.commit((tx) => {
        tx.write(files, { items: ["new"] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.read(files)).value).toEqual({ items: ["old"] });
    expect(await readdir(dir)).not.toContain("lock");
    expect(await put({ items: ["after"] })).toEqual({ committed: true });
  });

  test("tx.read sees the document on disk, not a stale copy", async () => {
    await put({ items: ["a"] });
    let seen: Files | undefined;
    await store.commit(async (tx) => {
      await writeFile(docPath(), JSON.stringify({ schemaVersion: 2, items: ["changed"] }));
      seen = await tx.read(files);
    });
    expect(seen).toEqual({ items: ["changed"] });
  });

  test("writes nothing and warns when the lock is held", async () => {
    await put({ items: ["old"] });
    await writeFile(join(dir, "lock"), JSON.stringify({ token: "other", createdAt: Date.now() }));
    const outcome = await store.commit((tx) => tx.write(files, { items: ["new"] }), { lockWaitMs: 60 });
    expect(outcome).toEqual({ committed: false, warning: "cache busy; this run was not cached" });
    expect((await store.read(files)).value).toEqual({ items: ["old"] });
    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).token).toBe("other");
  });

  test("breaks a stale lock", async () => {
    const lock = join(dir, "lock");
    await writeFile(lock, JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
    expect(await put()).toEqual({ committed: true });
    expect(await readdir(dir)).not.toContain("lock");
  });

  test("breaks a lock that is stale by modification time", async () => {
    const lock = join(dir, "lock");
    await writeFile(lock, "");
    const past = new Date(Date.now() - 120_000);
    await utimes(lock, past, past);
    expect(await put()).toEqual({ committed: true });
  });

  test("the stale threshold is configurable", async () => {
    const short = new DocumentStore(dir, { lockStaleMs: 10 });
    await writeFile(join(dir, "lock"), JSON.stringify({ token: "old", createdAt: Date.now() - 1000 }));
    expect(await short.commit((tx) => tx.write(files, { items: [] }))).toEqual({ committed: true });
  });

  test("does not delete a lock another holder now owns", async () => {
    await store.commit(async (tx) => {
      tx.write(files, { items: ["a"] });
      await writeFile(join(dir, "lock"), JSON.stringify({ token: "someone-else", createdAt: Date.now() }));
    });
    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).token).toBe("someone-else");
  });

  test("removes old stray .tmp files and keeps fresh ones", async () => {
    await put();
    const old = join(dir, ".files.aaaaaaaaaaaaaaaa.tmp");
    const fresh = join(dir, ".files.bbbbbbbbbbbbbbbb.tmp");
    await writeFile(old, "partial");
    await writeFile(fresh, "partial");
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    await put({ items: ["b"] });
    const names = await readdir(dir);
    expect(names).not.toContain(".files.aaaaaaaaaaaaaaaa.tmp");
    expect(names).toContain(".files.bbbbbbbbbbbbbbbb.tmp");
  });

  test("an interrupted write leaves the previous document readable", async () => {
    await put({ items: ["old"] });
    await writeFile(join(dir, ".files.cccccccccccccccc.tmp"), '{"schemaVersion":2,"ite');
    expect(await store.read(files)).toEqual({ value: { items: ["old"] } });
  });

  test.skipIf(process.getuid?.() === 0)("a read-only directory is not cached and does not throw", async () => {
    await chmod(dir, 0o500);
    const outcome = await put();
    expect(outcome.committed).toBe(false);
    expect(outcome).toHaveProperty("warning");
    expect((outcome as { warning: string }).warning).toStartWith("cache not written:");
  });
});

describe("concurrency", () => {
  test("commits from several processes serialize", async () => {
    const processes = 3;
    const times = 15;
    const counter: DocumentType<{ value: number }> = {
      name: "counter",
      schemaVersion: 1,
      validate: (payload): payload is { value: number } => typeof (payload as { value?: unknown }).value === "number",
    };
    const helper = join(import.meta.dir, "helpers", "store-increment.ts");
    const children = Array.from({ length: processes }, () =>
      Bun.spawn([process.execPath, helper, dir, String(times)], { stdout: "ignore", stderr: "pipe" }),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual(children.map(() => 0));
    expect((await store.read(counter)).value).toEqual({ value: processes * times });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp") || name === "lock")).toEqual([]);
  }, 15_000);
});
