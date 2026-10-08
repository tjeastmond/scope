import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never write a cache into a repository: in-process main() calls and spawned CLIs (which inherit this
// environment) run without it. Cache tests delete the variable around the code under test.
process.env.SCOPE_CACHE = "off";
// The cache's integrity key lives under XDG_STATE_HOME; tests must never touch the real ~/.local/state.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "scope-test-state-"));
