// Candidate recall, shared by scripts/recall.ts and scripts/adapt-weights.ts: the share of each labeled task's
// required labels that retrieval puts in the shortlist before Jev sees it. Retrieval only; no Jev, no cache, no history.

import { selectCandidates } from "../src/retrieval/candidates.ts";
import type { RetrievalConfig } from "../src/retrieval/config.ts";
import type { CodeChunk } from "../src/types.ts";
import { loadLabeledTasks, resolve, type LabeledTask } from "../tests/helpers/labels.ts";

export interface TaskRecall {
  fixture: string;
  task: LabeledTask;
  found: string[];
  missed: string[];
}

/** Splits `labels` into those present among `ids` (any chunk the label resolves to counts) and those missing. */
export function labelRecall(
  labels: readonly string[],
  chunks: readonly CodeChunk[],
  ids: ReadonlySet<string>,
  context = "labels",
): { found: string[]; missed: string[] } {
  const found: string[] = [];
  const missed: string[] = [];
  for (const label of labels) {
    const resolved = resolve(label, chunks);
    if (resolved.length === 0) throw new Error(`${context}: label does not match any chunk: ${label}`);
    (resolved.some((chunk) => ids.has(chunk.id)) ? found : missed).push(label);
  }
  return { found, missed };
}

export const pct = (found: number, total: number) => (total === 0 ? "n/a" : `${((100 * found) / total).toFixed(0)}%`);

/**
 * A label is present when any chunk it resolves to is in the shortlist; an unresolvable label is a labeling error.
 * `config` (default: the baseline) and `split` (default: every task) choose what is measured.
 */
export async function measureRecall(
  fixture: string,
  chunks: readonly CodeChunk[],
  options: { config?: RetrievalConfig; split?: LabeledTask["split"] } = {},
): Promise<TaskRecall[]> {
  const results: TaskRecall[] = [];
  for (const task of await loadLabeledTasks(fixture)) {
    if (options.split !== undefined && task.split !== options.split) continue;
    const shortlist = new Set(selectCandidates(task.task, chunks, options.config).candidates.map((chunk) => chunk.id));
    const result: TaskRecall = {
      fixture,
      task,
      ...labelRecall(task.required, chunks, shortlist, `${fixture}/${task.id}`),
    };
    results.push(result);
  }
  return results;
}
