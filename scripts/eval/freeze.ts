// Label freeze and fixture lock checks. A run on the heldout split is only comparable if the labels did not change after
// they were frozen, and every run needs fixtures that match the revisions the labels were written against.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFixture, readLock } from "./fixture-hash.ts";
import { FIXTURES, FREEZE_NAME, LOCK_NAME, TASKS } from "./labels.ts";

/** Raised for conditions the person running the harness must fix; the CLI prints the message without a stack. */
export class EvalError extends Error {}

export interface FreezeFile {
  /** sha256 over every `tasks/*.json` except the lock and freeze files: sorted names, byte lengths and bytes. */
  checksum: string;
  /** Git commit the labels were frozen at. */
  commit: string;
  /** ISO date of the freeze. */
  date: string;
  /** The files the checksum covers, sorted. */
  files: string[];
}

/** Checksum of the labels: `<name>\0<byte length>\0<bytes>\0` for each task file in sorted name order. */
export async function labelsChecksum(tasksDir = TASKS): Promise<{ checksum: string; files: string[] }> {
  const files = (await readdir(tasksDir))
    .filter((name) => name.endsWith(".json") && name !== LOCK_NAME && name !== FREEZE_NAME)
    .sort();
  const hash = createHash("sha256");
  for (const name of files) {
    const bytes = await readFile(join(tasksDir, name));
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return { checksum: hash.digest("hex"), files };
}

export async function writeFreeze(commit: string, date: string, tasksDir = TASKS): Promise<FreezeFile> {
  const { checksum, files } = await labelsChecksum(tasksDir);
  const freeze: FreezeFile = { checksum, commit, date, files };
  await writeFile(join(tasksDir, FREEZE_NAME), `${JSON.stringify(freeze, null, 2)}\n`);
  return freeze;
}

/** Throws unless `labels.freeze.json` exists and matches the current labels. Returns the checksum. */
export async function assertFrozen(tasksDir = TASKS): Promise<string> {
  let frozen: FreezeFile;
  try {
    frozen = JSON.parse(await readFile(join(tasksDir, FREEZE_NAME), "utf8")) as FreezeFile;
  } catch {
    throw new EvalError(
      `${FREEZE_NAME} is missing or unreadable, so the heldout split cannot be used. Freeze the labels with ` +
        "`bun run eval:freeze`, or run `--split tuning`.",
    );
  }
  const { checksum } = await labelsChecksum(tasksDir);
  if (checksum !== frozen.checksum) {
    throw new EvalError(
      `The labels changed after they were frozen (frozen ${frozen.checksum.slice(0, 12)} at ${frozen.commit.slice(0, 12)}, ` +
        `now ${checksum.slice(0, 12)}). Heldout results would not be comparable. Run \`bun run eval:freeze\` ` +
        "to freeze the new labels deliberately, or run `--split tuning`.",
    );
  }
  return checksum;
}

/** Throws unless each fixture matches its revision in `fixtures.lock.json`. Returns the hashes. */
export async function assertFixtureLock(
  fixtures: readonly string[],
  { fixturesDir = FIXTURES, tasksDir = TASKS }: { fixturesDir?: string; tasksDir?: string } = {},
): Promise<Record<string, string>> {
  const lock = await readLock(join(tasksDir, LOCK_NAME));
  const hashes: Record<string, string> = {};
  for (const fixture of [...fixtures].sort()) {
    const actual = await hashFixture(fixture, fixturesDir);
    if (actual !== lock[fixture]) {
      throw new EvalError(
        `Fixture ${fixture} does not match ${LOCK_NAME} (locked ${(lock[fixture] ?? "none").slice(0, 12)}, ` +
          `now ${actual.slice(0, 12)}). Relabel the affected tasks and update the lock before running (docs/evaluation.md).`,
      );
    }
    hashes[fixture] = actual;
  }
  return hashes;
}
