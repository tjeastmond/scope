// `bun run eval:freeze`: records the checksum of the current labels so heldout runs can prove they did not change.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFreeze } from "./freeze.ts";
import { FREEZE_NAME } from "./labels.ts";

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: join(import.meta.dir, "../.."),
  encoding: "utf8",
}).trim();
const freeze = await writeFreeze(commit, new Date().toISOString().slice(0, 10));
console.log(
  `Froze ${freeze.files.length} label files in tasks/${FREEZE_NAME}: ${freeze.checksum} (commit ${commit.slice(0, 12)})`,
);
