import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JEV_QUESTION_VERSION } from "../src/config.ts";
import { planJevRequests } from "../src/jev/provider.ts";
import { renderFormat } from "../src/output/index.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

/**
 * The question design is locked by a checked-in snapshot of the planned request bodies. The snapshot records the
 * question version it was produced under: changing the question text or criteria changes the snapshot, and the version
 * assertion makes the author bump JEV_QUESTION_VERSION in the same change. Regenerate with
 * `UPDATE_GOLDEN=1 bun test tests/jev-questions.test.ts` and review the diff.
 */
const GOLDEN = join(import.meta.dir, "golden/jev-payload.json");
const TASK = "Add retry handling to webhook delivery";

const chunk = (
  file: string,
  name: string | undefined,
  startLine: number,
  endLine: number,
  content: string,
): CodeChunk => ({
  id: `${file}#${name ?? "anon"}`,
  file,
  language: "typescript",
  kind: "function",
  name,
  startLine,
  endLine,
  content,
  references: [],
});

const chunks = [
  chunk("src/zzqPath.ts", "zzqSymbol", 3, 6, "export function zzqSymbol() {\n  return 1;\n}"),
  chunk("src/zzqOther.ts", "zzqOtherSymbol", 10, 12, "export function zzqOtherSymbol() {\n  return 2;\n}"),
  chunk("src/zzqThird.ts", undefined, 1, 2, "export const zzqThird = 3;"),
];

let savedModel: string | undefined;
beforeEach(() => {
  savedModel = process.env.TYPESAFE_DEFAULT_MODEL;
  delete process.env.TYPESAFE_DEFAULT_MODEL;
});
afterEach(() => {
  if (savedModel === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
  else process.env.TYPESAFE_DEFAULT_MODEL = savedModel;
});

test("the planned question payload matches its golden snapshot, produced under the current question version", async () => {
  const actual = `${JSON.stringify({ questionVersion: JEV_QUESTION_VERSION, requests: planJevRequests(TASK, chunks) }, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") await writeFile(GOLDEN, actual);
  const expected = await readFile(GOLDEN, "utf8");
  expect(actual).toBe(expected);
  expect(JSON.parse(expected).questionVersion).toBe(JEV_QUESTION_VERSION);
});

test("each question names its candidate by state path and says how the candidate is identified", () => {
  const [request] = planJevRequests(TASK, chunks);
  const questions = request!.questions as Record<string, { instructions: string }>;
  expect(questions.c0!.instructions).toBe(
    "Is the code in `candidates.c0` (identified by its `path`, `symbol` and `lines`) needed to complete the task described in `task`?",
  );
  expect(Object.keys(questions)).toEqual(["c0", "c1", "c2"]);
});

test("no question's instructions contain repository text; it appears only in state", () => {
  const [request] = planJevRequests(TASK, chunks);
  const instructions = JSON.stringify(request!.questions);
  for (const planted of ["zzqPath", "zzqSymbol", "zzqOther", "zzqThird", "src/"]) {
    expect(instructions).not.toContain(planted);
  }
  expect(JSON.stringify(request!.state)).toContain("src/zzqPath.ts");
  expect(JSON.stringify(request!.state)).toContain("zzqSymbol");
});

const ROOT = join(import.meta.dir, "../fixtures/mixed-app");

test("a Jev-mode result reports the question version in JSON and text output", async () => {
  const { result } = await runScope({
    task: "invoice due date",
    repo: ROOT,
    provider: fakeProvider({ fallback: 0.9 }),
  });
  expect(result.jevQuestionVersion).toBe(JEV_QUESTION_VERSION);
  expect(JSON.parse(renderFormat("json", result)).jevQuestionVersion).toBe(JEV_QUESTION_VERSION);
  expect(renderFormat("text", result)).toContain(`Jev questions: ${JEV_QUESTION_VERSION}`);
  expect(renderFormat("markdown", result)).toContain("Jev questions:");
});

test("a --no-jev result reports no question version anywhere", async () => {
  const { result } = await runScope({ task: "invoice due date", repo: ROOT, noJev: true });
  expect(result.jevQuestionVersion).toBeUndefined();
  expect(JSON.parse(renderFormat("json", result))).not.toHaveProperty("jevQuestionVersion");
  expect(renderFormat("text", result)).not.toContain("Jev questions:");
  expect(renderFormat("markdown", result)).not.toContain("Jev questions:");
});
