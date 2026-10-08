// Test-only preload (`node --import <this file>`): freezes a child scope process at a known point of a cache write
// so a test can SIGKILL it there deterministically. KILL_POINT is "lock" (store lock just created), "tmp" (a document
// is fully written and flushed under its temporary name, not yet renamed) or "json:N" (the Nth document was just
// renamed into place). KILL_MARKER is a file the hook creates once frozen; the test waits for it, then kills the child.
import process from "node:process";
import { setInterval } from "node:timers";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, sep } from "node:path";

const point = process.env.KILL_POINT ?? "";
const marker = process.env.KILL_MARKER ?? "";
const inStore = (path) => String(path).includes(`${sep}store-v1${sep}`);
let renamed = 0;

async function freeze() {
  await fsp.writeFile(marker, point);
  setInterval(() => undefined, 1_000); // keep the event loop alive while frozen
  await new Promise(() => undefined);
}

const open = fsp.open;
const rename = fsp.rename;

fsp.open = async (path, ...rest) => {
  const handle = await open(path, ...rest);
  if (point === "lock" && inStore(path) && basename(String(path)) === "lock") await freeze();
  return handle;
};

fsp.rename = async (from, to, ...rest) => {
  const documentWrite = inStore(to) && String(to).endsWith(".json") && String(from).endsWith(".tmp");
  if (documentWrite && point === "tmp") await freeze();
  await rename(from, to, ...rest);
  if (documentWrite && point.startsWith("json:") && ++renamed === Number(point.slice(5))) await freeze();
};

syncBuiltinESMExports();
