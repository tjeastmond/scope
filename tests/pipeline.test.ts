import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CANDIDATES } from "../src/config.ts";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { loadLabeledTasks } from "./helpers/labels.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const ROOT = join(FIXTURES, "mixed-app");
const tasks = await loadLabeledTasks("mixed-app");
const dueDate = tasks.find((task) => task.id === "due-date-column")!;
// Spans the frontend, the SQL layer, the Python worker, its TOML config and the docs, so every language is relevant.
const CROSS_LANGUAGE_TASK =
  "Show each invoice due date in the invoice list, query it in SQL, and make the reminder worker retry attempts configurable from config/app.toml, then document it.";
const PROVISIONAL = /retrieval is provisional/;
const loaded = await loadChunks(ROOT);

const labelChunk = (label: string): CodeChunk | undefined => {
  const [file, name] = label.split("::");
  return loaded.chunks.find((chunk) => chunk.file === file && chunk.name === name);
};

/** Every entry's type, mode and content hash (symlinks by target). */
async function snapshot(root: string, directory = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(join(root, directory))) {
    const path = directory ? `${directory}/${name}` : name;
    const full = join(root, path);
    const info = await lstat(full);
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isSymbolicLink()) result[path] = `link ${await readlink(full)}`;
    else if (info.isDirectory()) Object.assign(result, { [path]: `dir ${mode}` }, await snapshot(root, path));
    else
      result[path] = `file ${mode} ${createHash("sha256")
        .update(await readFile(full))
        .digest("hex")}`;
  }
  return result;
}

test("--no-jev on the mixed fixture selects chunks across languages with no provisional-retrieval warning", async () => {
  expect(loaded.chunks.length).toBeGreaterThan(MAX_CANDIDATES);
  const { result } = await runScope({ task: CROSS_LANGUAGE_TASK, repo: ROOT, noJev: true, budget: 100_000 });
  const languages = new Set<string>(result.chunks.map((selected) => selected.chunk.language));
  for (const language of ["typescript", "python", "sql", "markdown"]) expect(languages).toContain(language);
  expect([...languages].some((language) => ["toml", "json", "yaml"].includes(language))).toBe(true);
  // Pulled-in supporting declarations come on top of the shortlist; every shortlisted chunk is still bounded.
  expect(result.chunks.filter((selected) => !selected.supportFor).length).toBeLessThanOrEqual(MAX_CANDIDATES);
  expect(result.warnings.some((warning) => PROVISIONAL.test(warning))).toBe(false);
  // Retrieval found every chunk except the supports, which carry no retrieval origin.
  expect(result.chunks.every((selected) => selected.origin !== undefined || selected.supportFor)).toBe(true);
  expect(result.chunks.some((selected) => Object.keys(selected.signals).length > 0)).toBe(true);
});

test("a task matching nothing succeeds with an empty artifact carrying retrieval's guidance, and never calls Jev", async () => {
  let called = false;
  const provider: DecisionProvider = {
    async decide() {
      called = true;
      return { judgments: [] };
    },
  };
  const { result } = await runScope({ task: "quuxfrobnicate", repo: ROOT, provider });
  expect(result.chunks).toEqual([]);
  expect(result.regions).toEqual([]);
  expect(result.warnings.some((warning) => /^No chunk matched the task/.test(warning))).toBe(true);
  expect(result.warnings).toContain("No relevant chunks found; the result is empty.");
  expect(called).toBe(false);
});

test("default mode with a fake provider judges the same chunk inventory as --no-jev", async () => {
  const judged: CodeChunk[][] = [];
  const inner = fakeProvider({ fallback: 0.9 });
  const provider: DecisionProvider = {
    decide: (request) => {
      judged.push([...request.candidates]);
      return inner.decide(request);
    },
  };
  const offline = await runScope({ task: CROSS_LANGUAGE_TASK, repo: ROOT, noJev: true, budget: 100_000 });
  const online = await runScope({ task: CROSS_LANGUAGE_TASK, repo: ROOT, provider, budget: 100_000 });
  expect(judged).toHaveLength(1);
  // The output order is by score density, so compare the inventories as sets.
  // Supporting declarations are pulled in unjudged, so they are not part of the judged inventory.
  const judgedInOutput = offline.result.chunks.filter((s) => !s.supportFor).map((s) => s.chunk.id);
  expect(judged[0]!.map((chunk) => chunk.id).sort()).toEqual(judgedInOutput.sort());
  expect(judged[0]).toEqual(selectCandidates(CROSS_LANGUAGE_TASK, loaded.chunks).candidates);
  expect(judged[0]!.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  expect(online.result.warnings.some((warning) => PROVISIONAL.test(warning))).toBe(false);
});

test("the shortlist on the mixed fixture is deterministic, capped, and holds both due-date chunks", () => {
  const first = selectCandidates(dueDate.task, loaded.chunks);
  const again = selectCandidates(dueDate.task, [...loaded.chunks].reverse());
  expect(first.candidates.map((c) => c.id)).toEqual(again.candidates.map((c) => c.id));
  expect(first.candidates).toHaveLength(MAX_CANDIDATES);
  expect(first.warning).toBeUndefined();
  const kept = new Set(first.candidates.map((chunk) => chunk.id));
  for (const label of dueDate.required) expect(kept.has(labelChunk(label)!.id)).toBe(true);
});

test("scanning and running never modify the source repository", async () => {
  const before = await snapshot(ROOT);
  await runScope({ task: dueDate.task, repo: ROOT, noJev: true });
  await runScope({ task: dueDate.task, repo: ROOT, provider: fakeProvider({ fallback: 0.9 }) });
  expect(await snapshot(ROOT)).toEqual(before);
});
