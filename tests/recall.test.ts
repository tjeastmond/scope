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
  const tasks = await loadLabeledTasks("mixed-app");
  const total = tasks.reduce((sum, task) => sum + task.required.length, 0);
  expect(output).toMatch(new RegExp(`^aggregate candidate recall: \\d+/${total}\\s+\\d+%`, "m"));
  // A task whose required chunks are all direct matches must be fully recalled, and say so.
  expect(output).toMatch(/mixed-app\/due-date-column \[tuning\]\s+2\/2\s+100%/);
  expect(output).not.toMatch(/missed: web\/src\/components\/InvoiceRow/);
});
