// Packaged-CLI smoke test: builds, packs, installs the tarball into a fresh temp project and runs the installed
// `scope` binary under real Node with a PATH that does not contain Bun.
// Usage: node scripts/smoke-node.mjs   (or: bun run smoke:node)
// Select the Node under test with SCOPE_NODE=/path/to/node (default: the node running this script).
// npm is found next to that Node, or in the distro location; override with SCOPE_NPM=/path/to/npm-cli.js.
// Needs network once: `npm install` fetches the package's runtime dependencies from the registry.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures/webhook-service");
const TASK = "Add retry handling to Stripe webhook processing";
const MIXED_FIXTURE = join(ROOT, "fixtures/mixed-app");
// Spans TypeScript, Python, SQL, TOML and Markdown so the lexical pre-filter keeps chunks from each.
const MIXED_TASK =
  "Show each invoice due date in the invoice list, query it in SQL, and make the reminder worker retry attempts configurable from config/app.toml, then document it.";
const NODE = resolve(process.env.SCOPE_NODE ?? process.execPath);
// npm's CLI entry sits next to the Node under test (nvm, fnm, Homebrew, nodejs.org) or in the distro package location.
const NPM_CANDIDATES = [
  process.env.SCOPE_NPM,
  join(dirname(dirname(NODE)), "lib/node_modules/npm/bin/npm-cli.js"),
  "/usr/share/nodejs/npm/bin/npm-cli.js",
].filter(Boolean);
const NPM = NPM_CANDIDATES.find((path) => existsSync(path));
// Node's own directory supplies node (for the `#!/usr/bin/env node` shebang); the system dirs supply env and sh.
const SAFE_PATH = [dirname(NODE), "/usr/bin", "/bin"].join(delimiter);
const SAFE_ENV = { ...process.env, PATH: SAFE_PATH, TYPESAFE_API_KEY: "" };

class SmokeFailure extends Error {}
const fail = (message) => {
  throw new SmokeFailure(message);
};

const run = (label, cmd, args, { cwd, env = SAFE_ENV } = {}) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) fail(`${label}: exit ${result.status}\n${result.stdout}${result.stderr}`);
  process.stdout.write(`ok   ${label}\n`);
  return result.stdout;
};

const expectIncludes = (label, text, needle) => {
  if (!text.includes(needle)) fail(`${label}: output lacks ${JSON.stringify(needle)}\n${text}`);
};

const bunOnPath = (path) =>
  path.split(delimiter).find((dir) => {
    try {
      accessSync(join(dir, "bun"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

if (!NPM) {
  process.stderr.write(`FAIL npm not found (tried ${NPM_CANDIDATES.join(", ")}); set SCOPE_NPM=/path/to/npm-cli.js\n`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "scope-smoke-"));
try {
  // Bun is allowed only for the build; everything after this runs without it.
  run("bun run build", "bun", ["run", "build"], { cwd: ROOT, env: process.env });

  const bunDir = bunOnPath(SAFE_PATH);
  if (bunDir) fail(`bun is on the sanitized PATH (${bunDir})`);
  process.stdout.write("ok   bun is absent from the sanitized PATH\n");

  const packDir = join(scratch, "pack");
  const projectDir = join(scratch, "project");
  mkdirSync(packDir);
  mkdirSync(projectDir);

  // --ignore-scripts: the prepack hook calls `bun run build`, which already ran above.
  run("npm pack", NODE, [NPM, "pack", "--ignore-scripts", "--pack-destination", packDir], { cwd: ROOT });
  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz")) ?? fail("npm pack produced no tarball");

  run("npm init", NODE, [NPM, "init", "-y"], { cwd: projectDir });
  run("npm install <tarball>", NODE, [NPM, "install", "--no-audit", "--no-fund", join(packDir, tarball)], {
    cwd: projectDir,
  });

  const scope = join(projectDir, "node_modules/.bin/scope");
  const help = run("scope --help", scope, ["--help"], { cwd: projectDir });
  expectIncludes("scope --help", help, "Usage: scope");
  const selection = run("scope <task> --no-jev", scope, [TASK, "--repo", FIXTURE, "--no-jev"], { cwd: projectDir });
  expectIncludes("scope <task> --no-jev", selection, "== src/util/retry.ts:");

  const mixed = run(
    "scope <task> --repo mixed-app --no-jev",
    scope,
    [MIXED_TASK, "--repo", MIXED_FIXTURE, "--no-jev"],
    {
      cwd: projectDir,
    },
  );
  for (const extension of [".ts", ".tsx", ".py", ".sql", ".toml", ".md"]) {
    if (!new RegExp(`^== \\S+${extension.replace(".", "\\.")}:`, "m").test(mixed)) {
      fail(`scope mixed-app --no-jev: output has no chunk from a ${extension} file\n${mixed}`);
    }
  }

  const version = run("node --version", NODE, ["--version"]).trim();
  process.stdout.write(`node ${version}: packaged CLI smoke passed\n`);
} catch (error) {
  if (!(error instanceof SmokeFailure)) throw error;
  process.stderr.write(`FAIL ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
