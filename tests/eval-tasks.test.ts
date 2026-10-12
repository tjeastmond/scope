import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadChunks } from "../src/scope.ts";
import { hashFixture, readLock } from "./helpers/fixture-hash.ts";
import { FIXTURES, labelsOf, loadLabeledTasks, resolve, TASKS, type LabeledTask } from "./helpers/labels.ts";

const LOCK = "fixtures.lock.json";
const fixtures = (await readdir(TASKS))
  .filter((file) => file.endsWith(".json") && file !== LOCK)
  .map((file) => file.slice(0, -5))
  .sort();
const loaded = new Map(
  await Promise.all(
    fixtures.map(
      async (fixture) =>
        [
          fixture,
          { tasks: await loadLabeledTasks(fixture), chunks: (await loadChunks(join(FIXTURES, fixture))).chunks },
        ] as const,
    ),
  ),
);
const all = fixtures.flatMap((fixture) => (loaded.get(fixture)?.tasks ?? []).map((task) => ({ fixture, task })));

describe("evaluation set", () => {
  test("every fixture directory has a task file and a lock entry", async () => {
    const directories = (await readdir(FIXTURES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(fixtures).toEqual(directories);
    expect(Object.keys(await readLock()).sort()).toEqual(directories);
  });

  test("the set has 22 to 28 tasks and about 60% are tuning", () => {
    expect(all.length).toBeGreaterThanOrEqual(22);
    expect(all.length).toBeLessThanOrEqual(28);
    const tuning = all.filter(({ task }) => task.split === "tuning").length;
    expect(tuning / all.length).toBeGreaterThan(0.5);
    expect(tuning / all.length).toBeLessThan(0.7);
  });

  test("every fixture has tuning and heldout tasks", () => {
    for (const fixture of fixtures) {
      const splits = new Set(loaded.get(fixture)?.tasks.map((task) => task.split));
      expect([fixture, [...splits].sort()]).toEqual([fixture, ["heldout", "tuning"]]);
    }
  });

  test("task ids are unique across all files", () => {
    const ids = all.map(({ task }) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the scope-snapshot set includes the max-candidates-flag task", () => {
    const task = loaded.get("scope-snapshot")?.tasks.find((candidate) => candidate.id === "max-candidates-flag");
    expect(task?.split).toBe("tuning");
    expect(task?.required).toEqual(
      expect.arrayContaining(["src/main.ts::parseCli", "src/scope.ts::prepareCandidates"]),
    );
  });
});

describe.each(fixtures)("%s labeled tasks", (fixture) => {
  const { tasks, chunks } = loaded.get(fixture) as {
    tasks: LabeledTask[];
    chunks: Awaited<ReturnType<typeof loadChunks>>["chunks"];
  };

  test("every task is well formed", () => {
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(["id", "irrelevant", "required", "split", "task", "useful"]);
      expect(task.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(["tuning", "heldout"]).toContain(task.split);
      expect(task.task.trim().length).toBeGreaterThan(10);
      for (const list of [task.required, task.useful, task.irrelevant]) {
        expect(Array.isArray(list)).toBe(true);
        for (const label of list) expect(typeof label).toBe("string");
      }
      expect(task.required.length).toBeGreaterThanOrEqual(1);
      expect(task.irrelevant.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("every label resolves to exactly one chunk", () => {
    const unresolved: string[] = [];
    for (const task of tasks) {
      for (const label of labelsOf(task)) {
        const found = resolve(label, chunks).length;
        if (found !== 1) unresolved.push(`${task.id}: ${label} matched ${found} chunks`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("no label or chunk appears twice within a task", () => {
    for (const task of tasks) {
      const labels = labelsOf(task);
      expect(new Set(labels).size).toBe(labels.length);
      const ids = labels.map((label) => resolve(label, chunks)[0]?.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("fixture revisions", () => {
  test("tasks/fixtures.lock.json matches the fixture contents", async () => {
    const lock = await readLock();
    for (const fixture of fixtures)
      expect([fixture, await hashFixture(fixture)]).toEqual([fixture, lock[fixture] ?? ""]);
  });

  test("the hash depends on file contents", async () => {
    expect(await hashFixture("webhook-service")).toBe(await hashFixture("webhook-service"));
    expect(await hashFixture("webhook-service")).not.toBe(await hashFixture("py-ingest"));
  });
});
