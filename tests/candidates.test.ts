import { expect, test } from "bun:test";
import { selectCandidates } from "../src/retrieval/candidates.ts";
import type { CodeChunk } from "../src/types.ts";

const chunk = (file: string, startLine: number, id: string, content = "", name = id): CodeChunk => ({
  id,
  file,
  language: "typescript",
  kind: "function",
  name,
  startLine,
  endLine: startLine + 1,
  content,
  references: [],
  estimatedTokens: 0,
});

const chunks = [chunk("b.ts", 1, "e"), chunk("a.ts", 9, "d"), chunk("a.ts", 2, "c"), chunk("a.ts", 2, "b")];

const ids = (task: string, input: readonly CodeChunk[], max?: number) =>
  selectCandidates(task, input, { max }).candidates.map((c) => c.id);

test("orders by path, start line, then ID regardless of input order", () => {
  const expected = ["b", "c", "d", "e"];
  expect(ids("task", chunks)).toEqual(expected);
  expect(ids("task", [...chunks].reverse())).toEqual(expected);
});

test("does not mutate its input", () => {
  const input = [...chunks];
  selectCandidates("task", input, { max: 2 });
  expect(input).toEqual(chunks);
});

test("returns every chunk without a warning at and under the cap", () => {
  expect(selectCandidates("task", chunks, { max: 4 })).toEqual({
    candidates: selectCandidates("task", chunks).candidates,
  });
  expect(selectCandidates("task", chunks, { max: 4 }).warning).toBeUndefined();
  expect(selectCandidates("task", chunks).warning).toBeUndefined();
});

test("over the cap, keeps the lexically relevant chunks in deterministic order and warns", () => {
  const input = [
    chunk("z/billing.ts", 1, "bill", "function renderDueDate() {}", "renderDueDate"),
    chunk("a/noise.ts", 1, "noise1", "const x = 1;"),
    chunk("a/noise.ts", 5, "noise2", "const y = 2;"),
    chunk("m/body.ts", 1, "body", "// show the due date here", "helper"),
    chunk("a/path_due_date.ts", 1, "path", "", "other"),
  ];
  const selection = selectCandidates("Show the due-date in the list", input, { max: 3 });
  expect(selection.candidates.map((c) => c.id)).toEqual(["path", "body", "bill"]);
  expect(selection.warning).toBe(
    "5 eligible chunks exceed the candidate cap of 3; candidates were pre-filtered by lexical overlap " +
      "(retrieval is provisional until Milestone 3)",
  );
});

test("the pre-filter is deterministic, honors the cap, and breaks ties by path, line and ID", () => {
  expect(ids("nothing matches", chunks, 2)).toEqual(["b", "c"]);
  expect(ids("nothing matches", [...chunks].reverse(), 2)).toEqual(["b", "c"]);
});

test("returns an empty list for an empty repository", () => {
  expect(selectCandidates("task", [])).toEqual({ candidates: [] });
});
