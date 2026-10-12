import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFixture } from "../scripts/eval/fixture-hash.ts";
import { assertFixtureLock, assertFrozen, EvalError, labelsChecksum, writeFreeze } from "../scripts/eval/freeze.ts";
import { FREEZE_NAME, LOCK_NAME } from "../scripts/eval/labels.ts";

const roots: string[] = [];
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "scope-eval-"));
  roots.push(root);
  const tasks = join(root, "tasks");
  const fixtures = join(root, "fixtures");
  await mkdir(tasks);
  await mkdir(join(fixtures, "demo"), { recursive: true });
  await writeFile(join(tasks, "demo.json"), "[]\n");
  await writeFile(join(fixtures, "demo", "a.ts"), "export const a = 1;\n");
  return { tasks, fixtures };
}
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("label freeze", () => {
  test("a matching freeze passes", async () => {
    const { tasks } = await scratch();
    const freeze = await writeFreeze("abc123", "2026-01-01", tasks);
    expect(freeze).toMatchObject({ commit: "abc123", date: "2026-01-01", files: ["demo.json"] });
    expect(await assertFrozen(tasks)).toBe(freeze.checksum);
  });

  test("refuses when the freeze file is missing", async () => {
    const { tasks } = await scratch();
    const error = await assertFrozen(tasks).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalError);
  });

  test("refuses when the labels changed after the freeze", async () => {
    const { tasks } = await scratch();
    await writeFreeze("abc123", "2026-01-01", tasks);
    await writeFile(join(tasks, "demo.json"), "[{}]\n");
    const error = await assertFrozen(tasks).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalError);
  });

  test("the lock and freeze files are not part of the checksum", async () => {
    const { tasks } = await scratch();
    const before = await labelsChecksum(tasks);
    await writeFile(join(tasks, LOCK_NAME), "{}\n");
    await writeFile(join(tasks, FREEZE_NAME), "{}\n");
    expect(await labelsChecksum(tasks)).toEqual(before);
  });
});

describe("fixture lock", () => {
  test("a matching lock passes", async () => {
    const { tasks, fixtures } = await scratch();
    await writeFile(join(tasks, LOCK_NAME), JSON.stringify({ demo: await hashFixture("demo", fixtures) }));
    await assertFixtureLock(["demo"], { fixturesDir: fixtures, tasksDir: tasks });
  });

  test("refuses when a fixture no longer matches the lock", async () => {
    const { tasks, fixtures } = await scratch();
    await writeFile(join(tasks, LOCK_NAME), JSON.stringify({ demo: await hashFixture("demo", fixtures) }));
    await writeFile(join(fixtures, "demo", "a.ts"), "export const a = 2;\n");
    const error = await assertFixtureLock(["demo"], { fixturesDir: fixtures, tasksDir: tasks }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EvalError);
  });
});
