// Labeled evaluation tasks (tasks/<fixture>.json) and the mapping from their labels to chunks.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeChunk } from "../../src/types.ts";
import type { LineRange } from "./matching.ts";

export const FIXTURES = join(import.meta.dir, "../../fixtures");
export const TASKS = join(import.meta.dir, "../../tasks");

export interface LabeledTask {
  id: string;
  /** Tasks may be tuned on only when `tuning`; `heldout` tasks measure generalization (see M7). */
  split: "tuning" | "heldout";
  task: string;
  required: string[];
  useful: string[];
  irrelevant: string[];
}

/** Files in `tasks/` that are not task lists. */
export const LOCK_NAME = "fixtures.lock.json";
export const FREEZE_NAME = "labels.freeze.json";

export async function loadLabeledTasks(fixture: string, tasksDir = TASKS): Promise<LabeledTask[]> {
  return JSON.parse(await readFile(join(tasksDir, `${fixture}.json`), "utf8")) as LabeledTask[];
}

/** Names of the fixtures that have a task file, sorted. */
export async function listTaskFixtures(tasksDir = TASKS): Promise<string[]> {
  return (await readdir(tasksDir))
    .filter((file) => file.endsWith(".json") && file !== LOCK_NAME && file !== FREEZE_NAME)
    .map((file) => file.slice(0, -5))
    .sort();
}

/** Resolves a label (`path::symbol`, `path::symbol@start-end` or a bare whole-file `path`) to the chunks it matches. */
export function resolve(label: string, chunks: readonly CodeChunk[]): CodeChunk[] {
  const split = label.indexOf("::");
  if (split < 0) {
    const inFile = chunks.filter((chunk) => chunk.file === label);
    return inFile.length === 1 && inFile[0]?.kind === "file" ? inFile : [];
  }
  const path = label.slice(0, split);
  const symbol = label.slice(split + 2);
  const ranged = /^(.*)@(\d+)-(\d+)$/.exec(symbol);
  const [name, start, end] = ranged
    ? [ranged[1], Number(ranged[2]), Number(ranged[3])]
    : [symbol, undefined, undefined];
  return chunks.filter(
    (chunk) =>
      chunk.file === path &&
      chunk.name === name &&
      (start === undefined || (chunk.startLine === start && chunk.endLine === end)),
  );
}

export const labelsOf = (task: LabeledTask) => [...task.required, ...task.useful, ...task.irrelevant];

/** The line range a label names. A label that does not match exactly one chunk is a labeling error. */
export function unitOf(label: string, chunks: readonly CodeChunk[]): LineRange {
  const found = resolve(label, chunks);
  const [chunk] = found;
  if (found.length !== 1 || !chunk)
    throw new Error(`Label ${label} matched ${found.length} chunks, expected exactly one.`);
  return { file: chunk.file, startLine: chunk.startLine, endLine: chunk.endLine };
}
