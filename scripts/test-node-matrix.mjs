// Runs the cache robustness suite once for each Node in SCOPE_NODES, so the built CLI is exercised under every Node
// that Scope supports (the issue #81 acceptance criterion names Node 24 and 26).
// Usage: SCOPE_NODES=/path/to/node24:/path/to/node26 node scripts/test-node-matrix.mjs   (or: bun run test:node-matrix)
// Each entry is the path of a node binary. Not part of `validate`, since it needs specific Node installs.
import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "tests/cache-robustness.test.ts";
const nodes = (process.env.SCOPE_NODES ?? "").split(delimiter).filter(Boolean);

if (nodes.length === 0) {
  process.stderr.write("SCOPE_NODES is empty: set it to colon-separated node binaries, for example\n");
  process.stderr.write(
    "  SCOPE_NODES=$HOME/.nvm/versions/node/v24.19.0/bin/node:$HOME/.nvm/versions/node/v26.10.0/bin/node\n",
  );
  process.exit(1);
}

const run = (label, cmd, args, env = process.env) => {
  process.stdout.write(`\n== ${label}\n`);
  const started = Date.now();
  const result = spawnSync(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stderr.write(`FAIL ${label} (${seconds}s)\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`ok   ${label} (${seconds}s)\n`);
};

run("bun run build", "bun", ["run", "build"]);
for (const node of nodes) {
  const version = spawnSync(node, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    process.stderr.write(`FAIL ${node} did not run: ${version.stderr}\n`);
    process.exit(1);
  }
  run(`${SUITE} under ${node} (${version.stdout.trim()})`, "bun", ["test", SUITE], {
    ...process.env,
    SCOPE_NODE: node,
  });
}
process.stdout.write(`\nok   suite passed under ${nodes.length} Node version(s)\n`);
