// Candidate recall: the share of each task's required labels that retrieval puts in the shortlist before Jev sees it,
// so it bounds what Jev can select. Usage: bun scripts/recall.ts [fixture ...] (default: every tasks/*.json).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks } from "../src/scope.ts";
import { FIXTURES, loadLabeledTasks, resolve, TASKS, type LabeledTask } from "../tests/helpers/labels.ts";

interface TaskRecall {
  fixture: string;
  task: LabeledTask;
  found: string[];
  missed: string[];
}

const pct = (found: number, total: number) => (total === 0 ? "n/a" : `${((100 * found) / total).toFixed(0)}%`);

/** A label is present when any chunk it resolves to is in the shortlist; an unresolvable label is a labeling error. */
async function measure(fixture: string): Promise<TaskRecall[]> {
  const { chunks } = await loadChunks(join(FIXTURES, fixture));
  const results: TaskRecall[] = [];
  for (const task of await loadLabeledTasks(fixture)) {
    const shortlist = new Set(selectCandidates(task.task, chunks).candidates.map((chunk) => chunk.id));
    const result: TaskRecall = { fixture, task, found: [], missed: [] };
    for (const label of task.required) {
      const resolved = resolve(label, chunks);
      if (resolved.length === 0) throw new Error(`${fixture}/${task.id}: label does not match any chunk: ${label}`);
      (resolved.some((chunk) => shortlist.has(chunk.id)) ? result.found : result.missed).push(label);
    }
    results.push(result);
  }
  return results;
}

const fixtures =
  process.argv.length > 2
    ? process.argv.slice(2)
    : (await readdir(TASKS))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
const all = (await Promise.all(fixtures.map(measure))).flat();

for (const { fixture, task, found, missed } of all) {
  const total = found.length + missed.length;
  console.log(`${fixture}/${task.id} [${task.split}]  ${found.length}/${total}  ${pct(found.length, total)}`);
  for (const label of missed) console.log(`  missed: ${label}`);
}
for (const split of ["tuning", "heldout"] as const) {
  const rows = all.filter((r) => r.task.split === split);
  const found = rows.reduce((sum, r) => sum + r.found.length, 0);
  const total = rows.reduce((sum, r) => sum + r.found.length + r.missed.length, 0);
  console.log(`${split}: ${found}/${total}  ${pct(found, total)}  (${rows.length} tasks)`);
}
const found = all.reduce((sum, r) => sum + r.found.length, 0);
const total = all.reduce((sum, r) => sum + r.found.length + r.missed.length, 0);
console.log(`aggregate candidate recall: ${found}/${total}  ${pct(found, total)}`);
