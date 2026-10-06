import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadLabeledTasks } from "./helpers/labels.ts";

test("the recall script prints per-task, per-split and aggregate candidate recall", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../scripts/recall.ts"), "mixed-app"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  for (const task of await loadLabeledTasks("mixed-app")) {
    expect(output).toMatch(
      new RegExp(`mixed-app/${task.id} \\[${task.split}\\]\\s+\\d+/${task.required.length}\\s+\\d+%`),
    );
  }
  expect(output).toMatch(/^tuning: \d+\/\d+/m);
  expect(output).toMatch(/^heldout: \d+\/\d+/m);
  expect(output).toMatch(/^aggregate candidate recall: \d+\/\d+\s+\d+%/m);
});
