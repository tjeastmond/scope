import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChunks, runScope } from "../src/scope.ts";
import { FIXTURES } from "../scripts/eval/labels.ts";

const MIXED = join(FIXTURES, "mixed-app");
const BROKEN =
  "api/src/broken/report.ts: syntax errors; text fallback produced 2 line window(s) over the lines the parser did not recover";
const BROKEN_FIRST = "api/src/broken/report.ts: syntax errors; extracted 1 declarations from the parseable regions";
const EMPTY_ANALYSIS = "web/src/main.tsx: analyzer extracted no chunks; text fallback produced 1 line window(s)";
const SUMMARY_ONE =
  "1 file(s) have no analyzer and were read as plain text windows (for example worker/requirements.txt)";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "scope-summary-"));
  cpSync(MIXED, repo, { recursive: true });
});
afterEach(() => rm(repo, { recursive: true, force: true }));

test("an expected fallback (no analyzer) is one summary line, while unexpected fallbacks still warn per file", async () => {
  // Without detail only syntax errors are listed; the rest is counted (see warning-summary.test.ts).
  const brief = await loadChunks(MIXED);
  expect(brief.warnings).toContain(BROKEN_FIRST);
  expect(brief.warnings).not.toContain(EMPTY_ANALYSIS);
  expect(brief.fileWarnings.map((w) => w.kind)).toContain("no-chunks");
  const { warnings } = await loadChunks(MIXED, { detailed: true });
  expect(warnings).toContain(BROKEN);
  expect(warnings).toContain(EMPTY_ANALYSIS);
  expect(warnings).toContain(SUMMARY_ONE.replace("for example ", ""));
  expect(warnings.some((warning) => warning.includes("no analyzer for language"))).toBe(false);
});

test("many expected fallbacks stay one line with a count and a few examples; --explain lists more", async () => {
  for (let i = 0; i < 25; i++) await writeFile(join(repo, `extra${String(i).padStart(2, "0")}.go`), `package p${i}\n`);
  const summaries = async (detailed: boolean) =>
    (await loadChunks(repo, { detailed })).warnings.filter((warning) => warning.includes("no analyzer"));

  expect(await summaries(false)).toEqual([]);
  const detailed = await summaries(true);
  expect(detailed).toHaveLength(1);
  expect(detailed[0]).toContain("26 file(s) have no analyzer");
  expect(detailed[0]).toContain("extra19.go, and 6 more");
  expect(detailed[0]).not.toContain("for example");
});

test("the plain-text files reach the run result as a count, and --explain lists them", async () => {
  await writeFile(join(repo, "a.go"), "package a\n");
  const task = "Show each invoice due date";
  const plain = await runScope({ task, repo, noJev: true });
  const explained = await runScope({ task, repo, noJev: true, explain: true });
  expect(plain.result.warnings.some((warning) => warning.includes("no analyzer"))).toBe(false);
  expect(plain.result.warningSummary?.["plain-text"]).toBe(2);
  expect(explained.result.warnings).toContain(
    "2 file(s) have no analyzer and were read as plain text windows (a.go, worker/requirements.txt)",
  );
});
