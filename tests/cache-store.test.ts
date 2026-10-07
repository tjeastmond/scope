import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lutimes,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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

  test("non-integer schemaVersion, even when an older version could be migrated", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1.5, items: [] }));
    const outcome = await store.read({ ...files, migrate: (_from, payload) => payload as Files });
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("schemaVersion");
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

  test("a migration result that fails the shape check yields a warning", async () => {
    await writeFile(docPath(), JSON.stringify({ schemaVersion: 1, names: "bad" }));
    const outcome = await store.read({
      ...files,
      migrate: (_from, payload) => ({ items: (payload as { names: unknown }).names }) as Files,
    });
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("could not be migrated");
    expect(outcome.warning).not.toContain("\n");
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
  test("tx.list names the documents on disk and tx.removeName deletes by name", async () => {
    await put();
    await writeFile(docPath("other"), "{}");
    await writeFile(join(dir, "Bad_Name.json"), "{}");
    await writeFile(join(dir, "notes.txt"), "x");
    let listed: string[] = [];
    await store.commit(async (tx) => {
      listed = await tx.list();
      tx.removeName("other");
    });
    expect(listed).toEqual(["files", "other"]);
    expect(await readdir(dir)).not.toContain("other.json");
    expect(await readdir(dir)).toContain("files.json");
  });

  test("tx.list is empty when the store directory does not exist yet, and removeName rejects bad names", async () => {
    const fresh = new DocumentStore(join(dir, "missing"));
    let listed: string[] | undefined;
    await fresh.commit(async (tx) => {
      listed = await tx.list();
    });
    expect(listed).toEqual([]);
    await expect(
      store.commit((tx) => {
        tx.removeName("../escape");
      }),
    ).rejects.toThrow("invalid document name");
  });

  test("tx.list fails the commit when the directory cannot be listed", async () => {
    if (process.getuid?.() === 0) return;
    await put();
    await chmod(dir, 0o300);
    const outcome = store.commit(async (tx) => {
      await tx.list();
    });
    await expect(outcome).rejects.toThrow();
  });

  test("tx.read sees writes and removals staged earlier in the same transaction", async () => {
    await put({ items: ["disk"] });
    const seen: unknown[] = [];
    await store.commit(async (tx) => {
      const value = { items: ["staged"] };
      tx.write(files, value);
      value.items.push("mutated");
      const first = await tx.read(files);
      first?.items.push("mutated");
      seen.push(await tx.read(files));
      tx.remove(files);
      seen.push(await tx.read(files));
    });
    expect(seen).toEqual([{ items: ["staged"] }, undefined]);
  });

  for (const [failOn, stage] of [
    [1, "before taking the lock"],
    [2, "after taking the lock, before cleanup and update"],
    [3, "before writing"],
  ] as const) {
    test(`verifyDirectory failing ${stage} touches nothing and does not commit`, async () => {
      await put({ items: ["old"] });
      const old = new Date(Date.now() - 10 * 60_000);
      await writeFile(join(dir, "old.tmp"), "x");
      await utimes(join(dir, "old.tmp"), old, old);
      let calls = 0;
      let updated = false;
      const guarded = new DocumentStore(dir, {
        verifyDirectory: () => {
          calls += 1;
          if (calls >= failOn) throw new Error("directory replaced");
        },
      });
      const outcome = await guarded.commit((tx) => {
        updated = true;
        tx.write(files, { items: ["new"] });
      });
      expect(outcome).toEqual({ committed: false, warning: "cache not written: directory replaced" });
      expect(updated).toBe(failOn === 3);
      // The sweep runs once the directory has been verified under the lock, so only a late failure sees it done. Once
      // the directory fails verification, even our own lock is left for a later run to break.
      const expected = {
        1: ["files.json", "old.tmp"],
        2: ["files.json", "lock", "old.tmp"],
        3: ["files.json", "lock"],
      };
      expect((await readdir(dir)).sort()).toEqual(expected[failOn]);
      expect((await store.read(files)).value).toEqual({ items: ["old"] });
    });
  }

  for (const [failOn, stage] of [
    [2, "before claiming a stale lock"],
    [3, "before moving a stale lock away"],
  ] as const) {
    test(`verifyDirectory failing ${stage} leaves the stale lock in place`, async () => {
      const lockPath = join(dir, "lock");
      await writeFile(lockPath, JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
      const old = new Date(Date.now() - 120_000);
      await utimes(lockPath, old, old);
      let calls = 0;
      const guarded = new DocumentStore(dir, {
        verifyDirectory: () => {
          calls += 1;
          if (calls === failOn) throw new Error("directory replaced");
        },
      });
      const outcome = await guarded.commit((tx) => tx.write(files, { items: ["new"] }));
      expect(outcome).toEqual({ committed: false, warning: "cache not written: directory replaced" });
      expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe("dead");
      const claims = (await readdir(dir)).filter((name) => name.startsWith(".lock.break."));
      expect(claims).toHaveLength(failOn === 2 ? 0 : 1);
    });
  }

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

  test("a breaker that stalls after its re-check puts back a live lock it moved", async () => {
    const lock = join(dir, "lock");
    await writeFile(lock, JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
    const stalled = new DocumentStore(dir, {
      // Meanwhile another breaker removed the stale lock and a writer took a fresh one.
      beforeBreakRename: () => writeFile(lock, JSON.stringify({ token: "live", createdAt: Date.now() })),
    });
    const outcome = await stalled.commit((tx) => tx.write(files, { items: ["x"] }), { lockWaitMs: 150 });
    expect(outcome).toEqual({ committed: false, warning: "cache busy; this run was not cached" });
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("live");
    expect((await store.read(files)).value).toBeUndefined();
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

  test("writes nothing when the lock now belongs to another holder, and leaves that lock alone", async () => {
    await put({ items: ["old"] });
    const outcome = await store.commit(async (tx) => {
      tx.write(files, { items: ["new"] });
      await writeFile(join(dir, "lock"), JSON.stringify({ token: "someone-else", createdAt: Date.now() }));
    });
    expect(outcome).toEqual({ committed: false, warning: "cache lock lost; this run was not cached" });
    expect((await store.read(files)).value).toEqual({ items: ["old"] });
    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).token).toBe("someone-else");
  });

  const claimPath = (token: string, level: number) =>
    join(dir, `.lock.break.${createHash("sha256").update(token).digest("hex").slice(0, 16)}.${level}.tmp`);

  test("a fresh break claim keeps a stale lock in place and the commit busy", async () => {
    const lock = join(dir, "lock");
    await writeFile(lock, JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
    await writeFile(claimPath("dead", 0), "");
    const outcome = await store.commit((tx) => tx.write(files, { items: ["new"] }), { lockWaitMs: 100 });
    expect(outcome).toEqual({ committed: false, warning: "cache busy; this run was not cached" });
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("dead");
  });

  test("a stale break claim is skipped: the next level is claimed and the lock broken", async () => {
    await writeFile(join(dir, "lock"), JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
    const past = new Date(Date.now() - 120_000);
    await writeFile(claimPath("dead", 0), "");
    await utimes(claimPath("dead", 0), past, past);
    expect(await put()).toEqual({ committed: true });
    expect(await readdir(dir)).not.toContain("lock");
    expect(await readdir(dir)).toContain(claimPath("dead", 1).slice(dir.length + 1));
  });

  test("a FIFO as the lock does not hang the wait", async () => {
    expect(Bun.spawnSync(["mkfifo", join(dir, "lock")]).exitCode).toBe(0);
    const outcome = await store.commit((tx) => tx.write(files, { items: ["x"] }), { lockWaitMs: 100 });
    expect(outcome).toEqual({ committed: false, warning: "cache busy; this run was not cached" });
  }, 5000);

  test("a FIFO as the document reads as unusable without hanging", async () => {
    expect(Bun.spawnSync(["mkfifo", docPath()]).exitCode).toBe(0);
    const outcome = await store.read(files);
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("files.json");
  }, 5000);

  test("a symlink to a FIFO as the document reads as unusable without hanging", async () => {
    expect(Bun.spawnSync(["mkfifo", join(dir, "pipe")]).exitCode).toBe(0);
    await symlink(join(dir, "pipe"), docPath());
    const outcome = await store.read(files);
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("files.json");
  }, 5000);

  test("a document that is a symlink is not followed, even to a valid document", async () => {
    await writeFile(join(dir, "elsewhere.json"), JSON.stringify({ schemaVersion: 2, items: ["outside"] }));
    await symlink(join(dir, "elsewhere.json"), docPath());
    const outcome = await store.read(files);
    expect(outcome.value).toBeUndefined();
    expect(outcome.warning).toContain("files.json");
  });

  test("a dangling lock symlink does not hang the wait", async () => {
    await symlink(join(dir, "nowhere"), join(dir, "lock"));
    const started = Date.now();
    const outcome = await store.commit((tx) => tx.write(files, { items: ["x"] }), { lockWaitMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toEqual({ committed: false, warning: "cache busy; this run was not cached" });
  });

  test("a stale dangling lock symlink is broken", async () => {
    const lock = join(dir, "lock");
    await symlink(join(dir, "nowhere"), lock);
    const past = new Date(Date.now() - 120_000);
    await lutimes(lock, past, past);
    expect(await put()).toEqual({ committed: true });
    expect((await store.read(files)).value).toEqual({ items: ["a"] });
    expect(await readdir(dir)).not.toContain("lock");
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
    expect(
      (await readdir(dir)).filter(
        (name) => (name.endsWith(".tmp") && !name.startsWith(".lock.break.")) || name === "lock",
      ),
    ).toEqual([]);
  }, 15_000);

  test("several processes breaking the same stale lock all finish", async () => {
    await writeFile(join(dir, "lock"), JSON.stringify({ token: "dead", createdAt: Date.now() - 120_000 }));
    const processes = 4;
    const times = 5;
    const counter: DocumentType<{ value: number }> = {
      name: "counter",
      schemaVersion: 1,
      validate: (payload): payload is { value: number } => typeof (payload as { value?: unknown }).value === "number",
    };
    const helper = join(import.meta.dir, "helpers", "store-increment.ts");
    const children = Array.from({ length: processes }, () =>
      Bun.spawn([process.execPath, helper, dir, String(times)], { stdout: "ignore", stderr: "pipe" }),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(children.map(() => 0));
    expect((await store.read(counter)).value).toEqual({ value: processes * times });
    expect(await readdir(dir)).not.toContain("lock");
  }, 15_000);
});
