import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/main.ts";
import { classifyFileWarning, countFileWarnings, isOmittedByDefault, summarizeFileWarnings } from "../src/warnings.ts";

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

const SYNTAX_A = "src/a.ts: syntax errors; extracted 1 declarations from the parseable regions";
const SYNTAX_B = "src/b.ts: syntax errors; extracted 1 declarations from the parseable regions";
const MORE = "scope: warning: 1 more file had a scan warning (1 JSONC); rerun with --explain to list them";

test("syntax errors print once per file and the rest is one count line with the --explain hint", async () => {
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  expect(warningLines(run.stderr())).toEqual([`scope: warning: ${SYNTAX_A}`, `scope: warning: ${SYNTAX_B}`, MORE]);
});

test("a warning that is not about one file (a scan limit) is still printed on its own", async () => {
  let deep = "";
  for (let i = 0; i < 34; i++) deep = join(deep, `d${i}`);
  await mkdir(join(repo, deep), { recursive: true });
  await writeFile(join(repo, deep, "deep.ts"), "export const deep = 1;\n");
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  const lines = warningLines(run.stderr());
  expect(lines).toHaveLength(4);
  expect(lines).toContain(MORE);
  expect(lines.some((line) => line.includes("Directories nested deeper than"))).toBe(true);
});

test("--explain lists every warning individually, no count line and no hint", async () => {
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--explain"], run.io)).toBe(0);
  const lines = warningLines(run.stderr());
  expect(lines.some((line) => line.includes("more file"))).toBe(false);
  expect(run.stderr()).not.toContain("rerun with --explain");
  expect(lines.filter((line) => line.includes("src/a.ts: syntax errors"))).toHaveLength(2);
  expect(lines.filter((line) => line.includes("src/b.ts: syntax errors"))).toHaveLength(2);
  expect(lines.some((line) => line.includes("tsconfig.json: contains comments (JSONC)"))).toBe(true);
});

test("the JSON artifact lists syntax errors once per file and counts the rest; --explain lists everything", async () => {
  const plain = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "json"], plain.io)).toBe(0);
  const explained = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "json", "--explain"], explained.io)).toBe(0);
  const parsed = JSON.parse(plain.stdout()) as { warnings: string[]; warningSummary: object; schemaVersion: number };
  expect(parsed.schemaVersion).toBe(5);
  expect(parsed.warnings).toEqual([SYNTAX_A, SYNTAX_B]);
  expect(parsed.warningSummary).toEqual({ "syntax-error": 2, jsonc: 1 });
  const all = JSON.parse(explained.stdout()) as { warnings: string[]; warningSummary: object };
  expect(all.warnings).toContain("tsconfig.json: contains comments (JSONC); parsed leniently");
  expect(all.warnings.filter((w) => w.startsWith("src/a.ts: "))).toHaveLength(2);
  expect(all.warningSummary).toEqual(parsed.warningSummary);
});

test("the markdown artifact counts the unlisted kinds and omits the count line under --explain", async () => {
  const plain = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "markdown"], plain.io)).toBe(0);
  expect(plain.stdout()).toContain("- Files with other scan warnings (not listed; use `--explain`): 1 JSONC");
  expect(plain.stdout()).not.toContain("tsconfig.json: contains comments");
  const explained = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--format", "markdown", "--explain"], explained.io)).toBe(0);
  expect(explained.stdout()).not.toContain("Files with other scan warnings");
  expect(explained.stdout()).toContain("tsconfig.json: contains comments (JSONC)");
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

test("the omitted-warnings summary counts files per kind, orders kinds by count and pluralizes", () => {
  const warning = (file: string, message: string) => classifyFileWarning(file, `${file}: ${message}`);
  expect(summarizeFileWarnings([])).toBeUndefined();
  expect(summarizeFileWarnings([warning("a.json", "contains comments (JSONC); parsed leniently")])).toBe(
    "1 more file had a scan warning (1 JSONC); rerun with --explain to list them",
  );
  const mixed = [
    warning("a.ts", "syntax errors; extracted 1 declarations from the parseable regions"),
    warning("a.ts", "syntax errors; text fallback produced 2 line window(s)"),
    warning("b.ts", "analyzer extracted no chunks; text fallback produced 1 line window(s)"),
    warning("c.ts", "analyzer extracted no chunks; text fallback produced 1 line window(s)"),
    warning("d.bin", "binary content (NUL byte); skipped"),
  ];
  expect(summarizeFileWarnings(mixed)).toBe(
    "4 more files had scan warnings (2 no chunks, 1 syntax error, 1 binary file); rerun with --explain to list them",
  );
  expect(countFileWarnings(mixed)).toEqual({ "syntax-error": 1, "no-chunks": 2, binary: 1 });
  expect(summarizeFileWarnings(mixed.filter(isOmittedByDefault))).toContain("3 more files");
});

test("a repo with every kind of per-file warning prints the syntax errors and one count line", async () => {
  await writeFile(join(repo, "notes.txt"), "just text\n");
  await writeFile(join(repo, "main.go"), "package main\n");
  const run = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev"], run.io)).toBe(0);
  expect(warningLines(run.stderr())).toEqual([
    `scope: warning: ${SYNTAX_A}`,
    `scope: warning: ${SYNTAX_B}`,
    "scope: warning: 3 more files had scan warnings (2 plain text, 1 JSONC); rerun with --explain to list them",
  ]);
  const explained = capture();
  expect(await main(["ok", "--repo", repo, "--no-jev", "--explain"], explained.io)).toBe(0);
  expect(explained.stderr()).toContain("2 file(s) have no analyzer and were read as plain text windows");
});
