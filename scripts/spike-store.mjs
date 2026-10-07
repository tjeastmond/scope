// Spike for issue #68: exercises the compiled document store on plain Node (no Bun). Run `bun run build` first, then
// `node scripts/spike-store.mjs`. Prints one line per step and exits non-zero on the first failure.
import assert from "node:assert/strict";
import { Console } from "node:console";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DocumentStore } from "../dist/cache/store.js";

const files = {
  name: "files",
  schemaVersion: 1,
  validate: (payload) => typeof payload === "object" && payload !== null && typeof payload.count === "number",
};

const console = new Console(process.stdout, process.stderr);
const directory = await mkdtemp(join(tmpdir(), "scope-spike-store-"));
const step = (message) => console.log(`ok  ${message}`);
try {
  console.log(`node ${process.version}`);
  const store = new DocumentStore(join(directory, "store"));

  assert.deepEqual(await store.read(files), { value: undefined });
  step("missing document reads as empty without a warning");

  assert.deepEqual(await store.commit((tx) => tx.write(files, { count: 1 })), { committed: true });
  assert.deepEqual(await store.read(files), { value: { count: 1 } });
  step("commit then read back");

  const target = join(directory, "store", "files.json");
  await writeFile(join(directory, "store", ".files.0000000000000000.tmp"), '{"schemaVersion":1,"cou');
  assert.deepEqual(await store.read(files), { value: { count: 1 } });
  step("interrupted write (partial .tmp) leaves the old document readable");

  const size = (await readFile(target)).length;
  await truncate(target, Math.floor(size / 2));
  const corrupt = await store.read(files);
  assert.equal(corrupt.value, undefined);
  assert.match(corrupt.warning ?? "", /files\.json/);
  step(`truncated document reads as empty with a warning: ${corrupt.warning}`);

  assert.deepEqual(
    await store.commit(async (tx) => tx.write(files, { count: ((await tx.read(files))?.count ?? 0) + 1 })),
    { committed: true },
  );
  assert.deepEqual(await store.read(files), { value: { count: 1 } });
  step("next commit rewrites the document");
  console.log("spike passed");
} catch (error) {
  console.error(`spike failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
