// Labeled evaluation tasks (fixtures/*.tasks.json) and the mapping from their labels to chunks.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeChunk } from "../../src/types.ts";

export const FIXTURES = join(import.meta.dir, "../../fixtures");

export interface LabeledTask {
  id: string;
  task: string;
  required: string[];
  useful: string[];
  irrelevant: string[];
}

export async function loadLabeledTasks(fixture: string): Promise<LabeledTask[]> {
  return JSON.parse(await readFile(join(FIXTURES, `${fixture}.tasks.json`), "utf8")) as LabeledTask[];
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
