import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../scripts/eval/report.ts";
import { RECORDING_PATH, reportCommand } from "../scripts/eval/report-cli.ts";
import { evaluate, installedSdkVersion, type EvalOptions } from "../scripts/eval/runner.ts";

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-eval-report-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const small: EvalOptions = {
  modes: ["lexical", "no-jev", "jev"],
  split: "all",
  fixtures: ["webhook-service"],
  repeat: 1,
  replay: RECORDING_PATH,
  outDir: "unused",
  log: () => {},
};

describe("deterministic report", () => {
  test("omits clock, commit and output provenance and renders identically under different clocks", async () => {
    const at = (iso: string) => () => new Date(iso);
    const first = await evaluate({ ...small, now: at("2020-01-01T00:00:00Z") });
    const second = await evaluate({ ...small, now: at("2031-06-07T08:09:10Z") });
    const [a, b] = [first, second].map((o) => renderReport(o, { deterministic: true }));
    expect(a).toBe(b);
    expect(a).not.toContain("Started");
    expect(a).not.toContain("Finished");
    expect(a).not.toContain("Git commit");
    expect(a).toContain("Retrieval config version");
    expect(a).toContain("Labels checksum");
    expect(a).toContain("Replayed from");
    expect(renderReport(first)).toContain("Started");
    expect(renderReport(first)).not.toBe(renderReport(second));
  });
});

describe("eval:report --check", () => {
  test("passes on an identical file, fails on drift, and never writes in check mode", async () => {
    const dir = await scratch();
    const file = join(dir, "report.md");
    const options = { reportPath: file };
    expect(await reportCommand({ ...options, check: false })).toEqual({ upToDate: true, written: true });
    const fresh = await readFile(file, "utf8");
    expect(await reportCommand({ ...options, check: true })).toEqual({ upToDate: true, written: false });

    await writeFile(file, `${fresh}\nhand edit\n`);
    expect(await reportCommand({ ...options, check: true })).toEqual({ upToDate: false, written: false });
    expect(await readFile(file, "utf8")).toBe(`${fresh}\nhand edit\n`);

    expect((await reportCommand({ reportPath: join(dir, "missing.md"), check: true })).upToDate).toBe(false);
  });

  test("the committed report is current", async () => {
    expect((await reportCommand({ check: true })).upToDate).toBe(true);
  });
});

describe("installed SDK version", () => {
  test("is read from the installed package", async () => {
    // Found from wherever Bun resolves the package, so a worktree using the parent checkout's node_modules works too.
    const entry = Bun.resolveSync("@typesafe-ai/sdk", import.meta.dir);
    const root = entry.slice(
      0,
      entry.lastIndexOf("node_modules/@typesafe-ai/sdk/") + "node_modules/@typesafe-ai/sdk".length,
    );
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(await installedSdkVersion()).toBe(manifest.version);
  });
});
