import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CancelledError } from "../src/errors.ts";
import { main, type Io } from "../src/main.ts";
import { prepareOutput } from "../src/output/file.ts";
import { FORMATS } from "../src/output/index.ts";
import type { DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { FIXTURES, loadLabeledTasks } from "./helpers/labels.ts";

const task = (await loadLabeledTasks("mixed-app"))[0]!.task;
const SOURCE = "api/src/models/invoice.ts";

let tmp: string;
let repo: string;
const savedKey = process.env.TYPESAFE_API_KEY;
beforeEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  tmp = await mkdtemp(join(tmpdir(), "scope-output-"));
  repo = join(tmp, "repo");
  cpSync(join(FIXTURES, "mixed-app"), repo, { recursive: true });
  await mkdir(join(tmp, "out"));
});
afterEach(async () => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
  chmodSync(join(tmp, "out"), 0o700);
  await rm(tmp, { recursive: true, force: true });
});

function capture(provider?: DecisionProvider) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), provider };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const spyProvider = () => {
  const calls: number[] = [];
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      calls.push(1);
      return inner.decide(request);
    },
  };
  return { provider, calls };
};

const args = (...extra: string[]) => [task, "--repo", repo, ...extra];

test.each([...FORMATS])("%s: the file holds exactly what stdout would, and stdout stays empty", async (format) => {
  const toStdout = capture();
  expect(await main(args("--no-jev", "--format", format, "--explain"), toStdout.io)).toBe(0);
  const target = join(tmp, "out", "artifact");
  const toFile = capture();
  expect(await main(args("--no-jev", "--format", format, "--explain", "--output", target), toFile.io)).toBe(0);
  expect(toFile.stdout()).toBe("");
  expect(readFileSync(target, "utf8")).toBe(toStdout.stdout());
  expect(toFile.stderr()).toContain(`scope: wrote ${target}\n`);
  expect(readdirSync(join(tmp, "out"))).toEqual(["artifact"]);
});

test("warnings and Jev usage go to stderr before the wrote line", async () => {
  const target = join(tmp, "out", "artifact.txt");
  const run = capture(fakeProvider({ fallback: 0.6 }));
  expect(await main(args("--output", target), run.io)).toBe(0);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toMatch(/scope: Jev .*tokens\nscope: wrote /);
  expect(run.stderr().trimEnd().split("\n").at(-1)).toBe(`scope: wrote ${target}`);
});

test("a missing directory fails before any Jev request and writes nothing", async () => {
  const { provider, calls } = spyProvider();
  const target = join(tmp, "missing", "artifact.txt");
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(run.stdout()).toBe("");
  expect(run.stderr().trim().split("\n")).toHaveLength(1);
  expect(run.stderr()).toContain(`cannot write --output ${target}: the directory does not exist`);
  expect(existsSync(join(tmp, "missing"))).toBe(false);
});

test.skipIf(process.getuid?.() === 0)("a read-only directory fails before any Jev request", async () => {
  const { provider, calls } = spyProvider();
  chmodSync(join(tmp, "out"), 0o500);
  const target = join(tmp, "out", "artifact.txt");
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(run.stderr()).toContain(`cannot write --output ${target}: permission denied`);
  expect(readdirSync(join(tmp, "out"))).toEqual([]);
});

test("a directory target is refused", async () => {
  const { provider, calls } = spyProvider();
  const run = capture(provider);
  expect(await main(args("--output", join(tmp, "out")), run.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(run.stderr()).toContain("the path is a directory");
  expect(readdirSync(join(tmp, "out"))).toEqual([]);
});

const refusals: [string, () => string][] = [
  ["an absolute path", () => join(repo, SOURCE)],
  ["a relative path", () => relative(process.cwd(), join(repo, SOURCE))],
  ["a path with dot segments", () => join(repo, "api", "..", SOURCE)],
  [
    "a symlink to the file",
    () => {
      const link = join(tmp, "out", "link.ts");
      symlinkSync(join(repo, SOURCE), link);
      return link;
    },
  ],
];

test.each(refusals)("refuses to overwrite a repository source file given as %s", async (_name, target) => {
  const before = readFileSync(join(repo, SOURCE), "utf8");
  const { provider, calls } = spyProvider();
  const run = capture(provider);
  const path = target();
  expect(await main(args("--output", path), run.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toContain(`cannot write --output ${path}: it is a source file of the repository`);
  expect(readFileSync(join(repo, SOURCE), "utf8")).toBe(before);
  expect(readdirSync(join(repo, "api/src/models")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a previous output is replaced and leaves no temporary files", async () => {
  const target = join(tmp, "out", "artifact.txt");
  await writeFile(target, "old output\n");
  const run = capture();
  expect(await main(args("--no-jev", "--output", target), run.io)).toBe(0);
  expect(readFileSync(target, "utf8")).toContain("Scope context for:");
  expect(readdirSync(join(tmp, "out"))).toEqual(["artifact.txt"]);
});

test("a run that fails after the preflight leaves neither the target nor a temporary file", async () => {
  const target = join(tmp, "out", "artifact.txt");
  const run = capture({ decide: async () => ({ judgments: [] }) });
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(readdirSync(join(tmp, "out"))).toEqual([]);
});

test("no temporary file exists while the run scans, and none is left after success", async () => {
  const target = join(tmp, "out", "artifact.txt");
  let during: string[] | undefined;
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      during = readdirSync(join(tmp, "out"));
      return inner.decide(request);
    },
  };
  expect(await main(args("--output", target), capture(provider).io)).toBe(0);
  expect(during).toEqual([]);
  expect(readdirSync(join(tmp, "out"))).toEqual(["artifact.txt"]);
});

test("a destination name at the file-name limit is accepted", async () => {
  const target = join(tmp, "out", `${"a".repeat(250)}.md`);
  expect(await main(args("--no-jev", "--output", target), capture().io)).toBe(0);
  expect(readdirSync(join(tmp, "out"))).toEqual([`${"a".repeat(250)}.md`]);
});

test("an existing in-repository file is refused when the scan was truncated", async () => {
  // Directories nested deeper than the scan limit are not scanned, so their files cannot be shown to be non-source.
  const deep = join(repo, ...Array.from({ length: 40 }, (_, i) => `d${i}`));
  await mkdir(deep, { recursive: true });
  const target = join(deep, "notes.txt");
  await writeFile(target, "keep me\n");
  const { provider, calls } = spyProvider();
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(run.stderr()).toContain("the repository scan was truncated");
  expect(calls).toHaveLength(0);
  expect(readFileSync(target, "utf8")).toBe("keep me\n");
});

test("a file that becomes source at the target during the run is not overwritten", async () => {
  const target = join(repo, "docs", "scope-out.md");
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      await writeFile(target, "created meanwhile\n");
      return inner.decide(request);
    },
  };
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(run.stderr()).toContain("it is a source file of the repository");
  expect(readFileSync(target, "utf8")).toBe("created meanwhile\n");
  expect(readdirSync(join(repo, "docs")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("an existing ignored target that stops being ignored during the run is not overwritten", async () => {
  await mkdir(join(repo, "generated"));
  await writeFile(join(repo, ".gitignore"), "generated/\n");
  const target = join(repo, "generated", "out.md");
  await writeFile(target, "previous\n");
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      await writeFile(join(repo, ".gitignore"), "");
      return inner.decide(request);
    },
  };
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(run.stderr()).toContain("it is a source file of the repository");
  expect(readFileSync(target, "utf8")).toBe("previous\n");
});

test("an output directory swapped for a symlink to source during the run is not written through", async () => {
  await mkdir(join(repo, "generated"));
  await writeFile(join(repo, ".gitignore"), "generated/\n");
  const target = join(repo, "generated", "out.ts");
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      await rm(join(repo, "generated"), { recursive: true });
      symlinkSync(join(repo, "api", "src", "models"), join(repo, "generated"));
      return inner.decide(request);
    },
  };
  const before = readFileSync(join(repo, SOURCE), "utf8");
  const run = capture(provider);
  expect(await main(args("--output", target), run.io)).toBe(1);
  expect(run.stderr()).toContain("the destination changed during the run");
  expect(readFileSync(join(repo, SOURCE), "utf8")).toBe(before);
  expect(existsSync(join(repo, "api", "src", "models", "out.ts"))).toBe(false);
});

test("a Ctrl-C that lands after Jev answers writes nothing and leaves the destination as it was", async () => {
  const target = join(tmp, "out", "artifact");
  await writeFile(target, "previous artifact\n");
  const controller = new AbortController();
  const inner = fakeProvider({ fallback: 0.6 });
  const provider: DecisionProvider = {
    decide: async (request) => {
      const result = await inner.decide(request);
      controller.abort();
      return result;
    },
  };
  const run = capture(provider);
  const code = await main(args("--output", target), { ...run.io, signal: controller.signal });

  expect(code).toBe(1);
  expect(run.stdout()).toBe("");
  expect(run.stderr()).toBe("scope: Cancelled: the run was interrupted before it finished\n");
  expect(readFileSync(target, "utf8")).toBe("previous artifact\n");
  expect(readdirSync(join(tmp, "out"))).toEqual(["artifact"]);
});

test("commit with a cancelled signal leaves the destination untouched and no temporary file", async () => {
  const target = join(tmp, "out", "artifact");
  await writeFile(target, "previous artifact\n");
  const controller = new AbortController();
  const output = await prepareOutput(repo, target, controller.signal);
  controller.abort();

  await expect(output.commit("new artifact\n")).rejects.toThrow(CancelledError);
  await output.discard();
  expect(readFileSync(target, "utf8")).toBe("previous artifact\n");
  expect(readdirSync(join(tmp, "out"))).toEqual(["artifact"]);
});

test("a cancelled signal stops the --output safety scan during preparation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareOutput(repo, join(tmp, "out", "artifact"), controller.signal)).rejects.toThrow(CancelledError);
  expect(readdirSync(join(tmp, "out"))).toEqual([]);
});
