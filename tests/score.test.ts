import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildIndexes } from "../src/retrieval/indexes.ts";
import { DEFAULT_SCORING_WEIGHTS, scoreChunks, type ChunkScore } from "../src/retrieval/score.ts";
import { extractTaskTerms } from "../src/retrieval/terms.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";
import { FIXTURES, loadLabeledTasks, resolve } from "./helpers/labels.ts";

const { chunks } = await loadChunks(join(FIXTURES, "mixed-app"));
const indexes = buildIndexes(chunks);
const tasks = await loadLabeledTasks("mixed-app");
const scoreTask = (task: string, weights = DEFAULT_SCORING_WEIGHTS) =>
  scoreChunks(extractTaskTerms(task), indexes, weights);

/** 1-based rank of the labeled chunk, or Infinity when no signal reached it. */
function rankOf(scores: readonly ChunkScore[], label: string): number {
  const index = scores.findIndex((score) => score.chunkId === resolve(label, chunks)[0]?.id);
  return index < 0 ? Infinity : index + 1;
}

describe("scoreChunks on the mixed fixture", () => {
  test.each(tasks.map((task) => [task.id, task] as const))("%s: the best required chunk leads", (_id, task) => {
    const scores = scoreTask(task.task);
    const bestRequired = Math.min(...task.required.map((label) => rankOf(scores, label)));
    const bestIrrelevant = Math.min(...task.irrelevant.map((label) => rankOf(scores, label)));
    expect(bestRequired).toBeLessThanOrEqual(10);
    expect(bestRequired).toBeLessThan(bestIrrelevant);
  });

  test("an exact identifier in the task puts that symbol on top", () => {
    const scores = scoreTask("Fix `InvoiceService.listByStatus` ordering");
    expect(scores[0]?.chunkId).toBe(
      resolve("api/src/services/invoiceService.ts::InvoiceService.listByStatus", chunks)[0]?.id,
    );
    expect(scores[0]?.signals.symbol).toBe(1);
  });

  test("a named file path lifts its chunks through the path signal", () => {
    const scores = scoreTask("Edit config/app.toml");
    const inFile = scores.filter((score) => indexes.byId.get(score.chunkId)?.file === "config/app.toml");
    expect(inFile.length).toBeGreaterThan(0);
    for (const score of inFile) expect(score.signals.path).toBe(1);
  });

  test("every score carries its breakdown: signals in [0, 1], total is the sum of the contributions", () => {
    for (const task of tasks) {
      for (const score of scoreTask(task.task)) {
        for (const signal of Object.values(score.signals)) {
          expect(signal).toBeGreaterThanOrEqual(0);
          expect(signal).toBeLessThanOrEqual(1);
        }
        const { symbol, lexical, path } = score.contributions;
        expect(score.total).toBe(symbol + lexical + path);
        expect(score.contributions.symbol).toBe(DEFAULT_SCORING_WEIGHTS.symbol * score.signals.symbol);
        expect(score.total).toBeGreaterThan(0);
        expect(score.total).toBeLessThanOrEqual(0.7);
      }
    }
  });

  test("the lexical signal is normalized so the best match is exactly 1", () => {
    for (const task of tasks) {
      expect(Math.max(...scoreTask(task.task).map((score) => score.signals.lexical))).toBe(1);
    }
  });

  test("ordering is total, descending and independent of chunk input order", () => {
    const task = tasks[0]!.task;
    const reference = scoreTask(task);
    for (let i = 1; i < reference.length; i++) {
      expect(reference[i - 1]!.total).toBeGreaterThanOrEqual(reference[i]!.total);
    }
    const shuffled = [...chunks].sort((a, b) => (a.id < b.id ? 1 : -1));
    expect(scoreChunks(extractTaskTerms(task), buildIndexes(shuffled))).toEqual(reference);
  });

  test("equal totals are ordered by file, start line, then id", () => {
    const tied = scoreTask("invoice").filter((score, _i, all) => score.total === all[0]?.total);
    const keys = tied
      .map((score) => indexes.byId.get(score.chunkId)!)
      .map((c) => `${c.file}:${String(c.startLine).padStart(6, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });

  test("weights change the ranking", () => {
    const task = tasks[0]!.task;
    const defaults = scoreTask(task);
    const pathOnly = scoreTask(task, { symbol: 0, lexical: 0, path: 1 });
    expect(pathOnly.map((score) => score.chunkId)).not.toEqual(defaults.map((score) => score.chunkId));
    for (const score of pathOnly) {
      expect(score.contributions.symbol).toBe(0);
      expect(score.contributions.lexical).toBe(0);
      expect(score.total).toBe(score.signals.path);
    }
  });

  test.each(["", "   ", "the of and"])("task %p without usable terms scores nothing", (task) => {
    expect(scoreTask(task)).toEqual([]);
  });

  test("terms that match nothing score nothing", () => {
    expect(scoreTask("`zzqxNothingMatches` quuxfrobnicate")).toEqual([]);
  });
});

describe("scoreChunks signal formulas", () => {
  const make = (file: string, name: string, content = "zzz"): CodeChunk => ({
    id: `${file}::${name}`,
    file,
    language: "typescript",
    kind: "function",
    name,
    startLine: 1,
    endLine: 1,
    content,
    references: [],
    estimatedTokens: 1,
  });
  const score = (task: string, list: CodeChunk[], weights = DEFAULT_SCORING_WEIGHTS) =>
    new Map(scoreChunks(extractTaskTerms(task), buildIndexes(list), weights).map((s) => [s.chunkId, s]));

  test("a partial name match grows with the share of its words the task covers", () => {
    const scores = score("send the reminder", [
      make("a.ts", "sendReminder"),
      make("b.ts", "send"),
      make("c.ts", "sendMoney"),
    ]);
    expect(scores.get("a.ts::sendReminder")?.signals.symbol).toBeCloseTo(0.6, 10);
    expect(scores.get("b.ts::send")?.signals.symbol).toBeCloseTo(0.45, 10);
    expect(scores.get("c.ts::sendMoney")?.signals.symbol).toBeCloseTo(0.9 * 0.5 * 0.5, 10);
  });

  test("only the last member of a dotted name counts", () => {
    const scores = score("send", [make("a.ts", "Invoice.send")]);
    expect(scores.get("a.ts::Invoice.send")?.signals.symbol).toBeCloseTo(0.45, 10);
  });

  test("the path signal is the share of task words in the path, plus a base-name bonus, capped at 1", () => {
    const list = [make("src/invoice.ts", "f"), make("src/other.ts", "g")];
    expect(score("`invoice` plus ordering of things", list).get("src/invoice.ts::f")?.signals.path).toBeCloseTo(
      0.75,
      10,
    );
    expect(score("`invoice`", list).get("src/invoice.ts::f")?.signals.path).toBe(1);
    expect(score("plain invoice words please", list).get("src/invoice.ts::f")?.signals.path).toBeCloseTo(0.25, 10);
  });

  test("the base-name bonus counts once per file, however many terms name it", () => {
    const list = [make("src/invoiceService.ts", "f"), make("src/other.ts", "g")];
    const path = score("`invoiceService` plus ordering things", list).get("src/invoiceService.ts::f")?.signals.path;
    expect(path).toBeCloseTo(0.9, 10);
  });

  test("a file name in the task matches the path ending with it", () => {
    const scores = score("`app.toml` and lots of other unrelated words here", [make("config/app.toml", "f")]);
    expect(scores.get("config/app.toml::f")?.signals.path).toBe(1);
  });

  test("equal totals are ordered by file position, not by which signal found them", () => {
    const list = [make("src/zeta.ts", "reminder"), make("src/reminder.ts", "alpha")];
    const ranked = scoreChunks(extractTaskTerms("`reminder`"), buildIndexes(list), { symbol: 1, lexical: 0, path: 1 });
    expect(ranked.map((s) => s.chunkId)).toEqual(["src/reminder.ts::alpha", "src/zeta.ts::reminder"]);
    expect(ranked[0]?.total).toBe(ranked[1]?.total);
  });
});
