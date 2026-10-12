import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.ts";
import { classifyFileWarning, summarizeFileWarnings } from "../src/warnings.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const BROKEN = "export function ok() { return 1 }\nexport function broken( {\n";
const warningLines = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("scope: warning: "));

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "scope-warnsum-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/a.ts"), BROKEN);
  await writeFile(join(repo, "src/b.ts"), BROKEN);
  await writeFile(join(repo, "tsconfig.json"), '{\n  // comment\n  "compilerOptions": {}\n}\n');
});
afterEach(() => rm(repo, { recursive: true, force: true }));

test("mixed per-file warnings become one summary line with the file count and kinds", async () => {
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  expect(warningLines(run.stderr())).toEqual([
    "scope: warning: 3 files had scan warnings (2 syntax errors, 1 JSONC); rerun with --explain to list them",
  ]);
});

test("a warning that is not about one file (a scan limit) is still printed on its own", async () => {
  let deep = "";
  for (let i = 0; i < 34; i++) deep = join(deep, `d${i}`);
  await mkdir(join(repo, deep), { recursive: true });
  await writeFile(join(repo, deep, "deep.ts"), "export const deep = 1;\n");
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  const lines = warningLines(run.stderr());
  expect(lines).toHaveLength(2);
  expect(lines.some((line) => line.includes("3 files had scan warnings (2 syntax errors, 1 JSONC)"))).toBe(true);
  expect(lines.some((line) => line.includes("Directories nested deeper than"))).toBe(true);
});

test("--explain lists every warning individually and no summary", async () => {
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--explain"], run.io)).toBe(0);
  const lines = warningLines(run.stderr());
  expect(lines.some((line) => line.includes("files had scan warnings"))).toBe(false);
  expect(lines.filter((line) => line.includes("src/a.ts: syntax errors")).length).toBeGreaterThan(0);
  expect(lines.filter((line) => line.includes("src/b.ts: syntax errors")).length).toBeGreaterThan(0);
  expect(lines.some((line) => line.includes("tsconfig.json: contains comments (JSONC)"))).toBe(true);
});

test("the JSON artifact keeps every warning whether or not the stderr line is summarized", async () => {
  const plain = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "json"], plain.io)).toBe(0);
  const explained = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "json", "--explain"], explained.io)).toBe(0);
  const warnings = (JSON.parse(plain.stdout()) as { warnings: string[] }).warnings;
  expect(warnings.filter((w) => w.startsWith("src/a.ts: ")).length).toBeGreaterThan(0);
  expect(warnings.filter((w) => w.startsWith("src/b.ts: ")).length).toBeGreaterThan(0);
  expect(warnings).toContain("tsconfig.json: contains comments (JSONC); parsed leniently");
  expect((JSON.parse(explained.stdout()) as { warnings: string[] }).warnings).toEqual(warnings);
});

test("a clean repository prints no warning lines", async () => {
  const clean = await mkdtemp(join(tmpdir(), "scope-warnsum-clean-"));
  try {
    await writeFile(join(clean, "a.ts"), "export function ok() { return 1 }\n");
    const run = capture();
    expect(await main(["ok", "--repo", clean, "--no-jev"], run.io)).toBe(0);
    expect(run.stderr()).not.toContain("warning");
  } finally {
    await rm(clean, { recursive: true, force: true });
  }
});

test("kinds are classified from the message shape; unknown shapes are kept as other", () => {
  const kind = (message: string) => classifyFileWarning("x.ts", message).kind;
  expect(kind("x.ts: syntax errors; extracted 1 declarations from the parseable regions")).toBe("syntax-error");
  expect(kind("x.ts: syntax errors; text fallback produced 2 line window(s)")).toBe("syntax-error");
  expect(kind("x.ts: analyzer extracted no chunks; text fallback produced 1 line window(s)")).toBe("no-chunks");
  expect(kind("x.ts: analyzer failed (boom); text fallback produced 1 line window(s)")).toBe("analyzer-failed");
  expect(kind("x.ts: contains comments (JSONC); parsed leniently")).toBe("jsonc");
  expect(kind("x.ts: binary content (NUL byte); skipped")).toBe("binary");
  expect(kind("x.ts: something else; text fallback produced 1 line window(s)")).toBe("text-fallback");
  expect(kind("x.ts: unterminated string")).toBe("other");
});

test("the summary counts files per kind, orders kinds by count and pluralizes", () => {
  const warning = (file: string, message: string) => classifyFileWarning(file, `${file}: ${message}`);
  expect(summarizeFileWarnings([])).toBeUndefined();
  expect(summarizeFileWarnings([warning("a.json", "contains comments (JSONC); parsed leniently")])).toBe(
    "1 file had a scan warning (1 JSONC); rerun with --explain to list them",
  );
  expect(
    summarizeFileWarnings([
      warning("a.ts", "syntax errors; extracted 1 declarations from the parseable regions"),
      warning("a.ts", "syntax errors; text fallback produced 2 line window(s)"),
      warning("b.ts", "analyzer extracted no chunks; text fallback produced 1 line window(s)"),
      warning("c.ts", "analyzer extracted no chunks; text fallback produced 1 line window(s)"),
      warning("d.bin", "binary content (NUL byte); skipped"),
    ]),
  ).toBe("4 files had scan warnings (2 no chunks, 1 syntax error, 1 binary file); rerun with --explain to list them");
});

test("a repo with every kind of per-file warning, including plain-text files, prints exactly one warning line", async () => {
  await writeFile(join(repo, "notes.txt"), "just text\n");
  await writeFile(join(repo, "main.go"), "package main\n");
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  expect(warningLines(run.stderr())).toEqual([
    "scope: warning: 5 files had scan warnings (2 syntax errors, 2 plain text, 1 JSONC); rerun with --explain to list them",
  ]);
  const explained = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--explain"], explained.io)).toBe(0);
  expect(explained.stderr()).toContain("2 file(s) have no analyzer and were read as plain text windows");
});
