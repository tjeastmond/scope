import { expect, test } from "bun:test";
import { resolveRetrievalConfig } from "../src/retrieval/config.ts";
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
});

const SMALL = resolveRetrievalConfig({ shortlistSize: 3, expansion: { seedCount: 2, maxExpanded: 2 } });
const ids = (task: string, input: readonly CodeChunk[], config = SMALL) =>
  selectCandidates(task, input, config).candidates.map((c) => c.id);

const unrelated = (count: number) =>
  Array.from({ length: count }, (_, i) => chunk(`noise/f${i}.ts`, 1, `noise${i}`, "const x = 1;"));

test("a repository that fits in the shortlist sends every chunk, ranked ones first then in path order, without a warning", () => {
  const input = [chunk("b.ts", 1, "e"), chunk("a.ts", 9, "d"), chunk("a.ts", 2, "c"), chunk("z.ts", 1, "target")];
  const selection = selectCandidates(
    "fix target",
    input,
    resolveRetrievalConfig({ shortlistSize: 4, expansion: { seedCount: 2, maxExpanded: 2 } }),
  );
  expect(selection.candidates.map((c) => c.id)).toEqual(["target", "c", "d", "e"]);
  expect(selection.warning).toBeUndefined();
  expect(selection.ranking.has("target")).toBe(true);
});

test("over the shortlist size, keeps the best matches in rank order and caps the list", () => {
  const input = [
    chunk("z/billing.ts", 1, "bill", "function renderDueDate() {}", "renderDueDate"),
    chunk("m/body.ts", 1, "body", "// show the due date here", "helper"),
    chunk("a/path_due_date.ts", 1, "path", "", "other"),
    ...unrelated(5),
  ];
  const selection = selectCandidates("Show the due-date in the list", input, SMALL);
  expect(selection.candidates).toHaveLength(3);
  expect(selection.candidates.map((c) => c.id).sort()).toEqual(["bill", "body", "path"]);
  expect(selection.candidates[0]!.id).toBe("bill");
});

test("the shortlist is deterministic regardless of input order", () => {
  const input = [chunk("x/render_due_date.ts", 1, "a"), chunk("y/render_due_date.ts", 1, "b"), ...unrelated(6)];
  const expected = ids("render due date", input);
  expect(ids("render due date", [...input].reverse())).toEqual(expected);
  expect(expected.slice(0, 2)).toEqual(["a", "b"]);
});

test("does not mutate its input", () => {
  const input = [...unrelated(5), chunk("a.ts", 1, "target")];
  const copy = [...input];
  selectCandidates("fix target", input, SMALL);
  expect(input).toEqual(copy);
});

test("records signals, total and origin for the candidates retrieval found", () => {
  const input = [chunk("a/target.ts", 1, "t"), ...unrelated(5)];
  const found = selectCandidates("fix target", input, SMALL).ranking.get("t");
  expect(found?.origin).toBe("direct");
  expect(found?.total).toBeGreaterThan(0);
  expect(found?.signals.path).toBeGreaterThan(0);
});

test("warns when even the best candidate is weak, and when there is none", () => {
  // Only one word of eight appears in a path, so the best total score is tiny.
  const input = [...unrelated(6), chunk("lib/zebra.ts", 1, "weak", "const y = 2;", "unrelated")];
  const weak = selectCandidates("zebra alpha beta gamma delta epsilon theta kappa", input, SMALL);
  expect(weak.candidates.map((c) => c.id)).toEqual(["weak"]);
  expect(weak.warning).toMatch(/^Weak shortlist: the best of 1 candidates scores 0\.0\d, below 0\.1;/);
  const none = selectCandidates("quuxfrobnicate", unrelated(6), SMALL);
  expect(none.candidates).toEqual([]);
  expect(none.warning).toMatch(/^No chunk matched the task/);
});

test("a strong match produces no warning", () => {
  const input = [chunk("a/target.ts", 1, "target", "", "target"), ...unrelated(5)];
  expect(selectCandidates("fix target", input, SMALL).warning).toBeUndefined();
});

test("returns an empty list for an empty repository", () => {
  const selection = selectCandidates("task", []);
  expect(selection.candidates).toEqual([]);
  expect(selection.warning).toBeUndefined();
});
