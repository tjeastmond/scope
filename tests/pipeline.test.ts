import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CANDIDATES } from "../src/config.ts";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import { loadChunks, runScope } from "../src/scope.ts";
import type { CodeChunk, DecisionProvider } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const ROOT = join(FIXTURES, "mixed-app");
const tasks = JSON.parse(await readFile(join(FIXTURES, "mixed-app.tasks.json"), "utf8")) as {
  id: string;
  task: string;
  required: string[];
}[];
const dueDate = tasks.find((task) => task.id === "due-date-column")!;
// Spans the frontend, the SQL layer, the Python worker, its TOML config and the docs, so every language is relevant.
const CROSS_LANGUAGE_TASK =
  "Show each invoice due date in the invoice list, query it in SQL, and make the reminder worker retry attempts configurable from config/app.toml, then document it.";
const PROVISIONAL = /eligible chunks exceed the candidate cap of 30; candidates were pre-filtered/;
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

test("--no-jev on the mixed fixture selects chunks across languages and warns that retrieval is provisional", async () => {
  expect(loaded.chunks.length).toBeGreaterThan(MAX_CANDIDATES);
  const { result } = await runScope({ task: CROSS_LANGUAGE_TASK, repo: ROOT, noJev: true, budget: 100_000 });
  const languages = new Set<string>(result.chunks.map((selected) => selected.chunk.language));
  for (const language of ["typescript", "python", "sql", "markdown"]) expect(languages).toContain(language);
  expect([...languages].some((language) => ["toml", "json", "yaml"].includes(language))).toBe(true);
  expect(result.chunks.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  expect(result.warnings.filter((warning) => PROVISIONAL.test(warning))).toHaveLength(1);
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
  expect(judged[0]!.map((chunk) => chunk.id).sort()).toEqual(offline.result.chunks.map((s) => s.chunk.id).sort());
  expect(judged[0]).toEqual(selectCandidates(CROSS_LANGUAGE_TASK, loaded.chunks).candidates);
  expect(online.result.warnings.some((warning) => PROVISIONAL.test(warning))).toBe(true);
});

// Known gap: the due-date task's other required chunk, web/src/hooks/useInvoices.ts::InvoiceDto, shares no word with
// the task except the plural "invoices", so the lexical pre-filter drops it. Milestone 3 retrieval is meant to find it.
test("the pre-filter on the mixed fixture is deterministic, capped and keeps InvoiceRow for the due-date task", () => {
  const first = selectCandidates(dueDate.task, loaded.chunks);
  const again = selectCandidates(dueDate.task, [...loaded.chunks].reverse());
  expect(first.candidates.map((c) => c.id)).toEqual(again.candidates.map((c) => c.id));
  expect(first.candidates).toHaveLength(MAX_CANDIDATES);
  expect(first.warning).toMatch(PROVISIONAL);
  const kept = new Set(first.candidates.map((chunk) => chunk.id));
  const row = labelChunk("web/src/components/InvoiceRow.tsx::InvoiceRow");
  expect(dueDate.required).toContain("web/src/components/InvoiceRow.tsx::InvoiceRow");
  expect(kept.has(row!.id)).toBe(true);
  expect(selectCandidates(dueDate.task, loaded.chunks, { max: loaded.chunks.length }).warning).toBeUndefined();
});

test("scanning and running never modify the source repository", async () => {
  const before = await snapshot(ROOT);
  await runScope({ task: dueDate.task, repo: ROOT, noJev: true });
  await runScope({ task: dueDate.task, repo: ROOT, provider: fakeProvider({ fallback: 0.9 }) });
  expect(await snapshot(ROOT)).toEqual(before);
});
