// Candidate recall: the share of each task's required labels that retrieval puts in the shortlist before Jev sees it,
// so it bounds what Jev can select. Usage: bun scripts/recall.ts [fixture ...] (default: every tasks/*.json).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadChunks } from "../src/scope.ts";
import { FIXTURES, TASKS } from "../tests/helpers/labels.ts";
import { measureRecall, pct } from "./recall-lib.ts";

/** Loads the fixture and measures every task with the baseline config. */
const measure = async (fixture: string) => measureRecall(fixture, (await loadChunks(join(FIXTURES, fixture))).chunks);

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
