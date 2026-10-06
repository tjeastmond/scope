import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EmptySelectionError, selectWithinBudget } from "../src/context/select.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { main, type Io } from "../src/main.ts";
import { FORMATS, renderFormat, type OutputFormat } from "../src/output/index.ts";
import { renderText } from "../src/output/text.ts";
import { runScope } from "../src/scope.ts";
import type { CodeChunk, SelectedChunk, TokenEstimator } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { FIXTURES, loadLabeledTasks } from "./helpers/labels.ts";

const MIXED = join(FIXTURES, "mixed-app");

/** Deterministic pseudo-random budgets (a linear congruential generator, fixed seed). */
function seededBudgets(count: number): number[] {
  let state = 20240601;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return 1 + (state % 6000);
  });
}
const BUDGETS = [1, 5, 25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1200, 2000, 4000, 8000, ...seededBudgets(40)];

const measure = (format: OutputFormat, result: Parameters<typeof renderFormat>[1]) => {
  const artifact = renderFormat(format, result);
  return {
    estimatedTokens: heuristicEstimator.count(artifact),
    characters: artifact.length,
    lines: artifact.split("\n").length,
  };
};

const symbolOf = (label: string) => label.split("::")[1]?.replace(/@\d+-\d+$/, "") ?? "";

async function variedProvider() {
  const tasks = await loadLabeledTasks("mixed-app");
  const relevance: Record<string, number> = {};
  for (const task of tasks) {
    for (const label of task.useful) relevance[symbolOf(label)] = 0.7;
    for (const label of task.required) relevance[symbolOf(label)] = 0.95;
    for (const label of task.irrelevant) relevance[symbolOf(label)] = 0.1;
  }
  return { tasks, provider: fakeProvider({ relevance, fallback: 0.55 }) };
}

describe("the budget holds for the whole emitted artifact", () => {
  for (const noJev of [true, false]) {
    for (const format of FORMATS) {
      test(`${noJev ? "no-jev" : "jev"} / ${format}: every budget yields a fitting, truthfully measured artifact`, async () => {
        const { tasks, provider } = await variedProvider();
        let produced = 0;
        for (const { task } of tasks) {
          for (const budget of BUDGETS) {
            let result;
            try {
              ({ result } = await runScope({ task, repo: MIXED, budget, noJev, format, provider }));
            } catch (error) {
              expect(error).toBeInstanceOf(EmptySelectionError);
              continue;
            }
            produced++;
            const actual = measure(format, result);
            expect(actual.estimatedTokens).toBeLessThanOrEqual(budget);
            expect({
              estimatedTokens: result.estimatedTokens,
              characters: result.characters,
              lines: result.lines,
            }).toEqual(actual);
          }
        }
        expect(produced).toBeGreaterThan(20);
      }, 60_000);
    }
  }
});

const item = (id: string, score: number, content: string, file = `${id}.ts`): SelectedChunk => ({
  chunk: {
    id,
    file,
    language: "typescript",
    kind: "function",
    name: id,
    startLine: 1,
    endLine: content.split("\n").length,
    content,
    references: [],
    estimatedTokens: heuristicEstimator.count(content),
  },
  signals: {},
  relevance: score,
  score,
  reason: "test",
});

const base = {
  task: "do it",
  mode: "jev" as const,
  estimator: heuristicEstimator,
  chunks: new Map<string, CodeChunk>(),
};
const ids = (result: { chunks: SelectedChunk[] }) => result.chunks.map((c) => c.chunk.id);

test("markdown and JSON overhead can leave less room than text for the same budget", () => {
  const candidates = ["a", "b", "c", "d"].map((id, index) =>
    item(id, 0.9 - index * 0.05, `const ${id} = compute(first, second, third);\n`.repeat(6)),
  );
  const budget = heuristicEstimator.count(renderText(base.task, candidates));

  const text = selectWithinBudget(candidates, { ...base, budget, format: "text" });
  expect(ids(text)).toEqual(["a", "b", "c", "d"]);
  for (const format of ["markdown", "json"] as const) {
    let count = 0;
    try {
      const same = selectWithinBudget(candidates, { ...base, budget, format });
      count = ids(same).length;
      expect(heuristicEstimator.count(renderFormat(format, same))).toBeLessThanOrEqual(budget);
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySelectionError);
    }
    expect(count).toBeLessThan(4);
    // With room for the overhead, all four fit again.
    expect(ids(selectWithinBudget(candidates, { ...base, budget: budget * 3, format }))).toEqual(["a", "b", "c", "d"]);
  }
  const markdown = selectWithinBudget(candidates, { ...base, budget, format: "markdown" });
  expect(ids(markdown).length).toBeGreaterThan(0);
});

test("the greedy pass charges the format's overhead, so a dense chunk is kept over a larger one that no longer fits", () => {
  // `dense` is chosen first; `large` is more relevant and would fit as text, but not once markdown headers are added.
  const dense = item("dense", 0.6, "const d = 1;");
  const large = item("large", 0.95, "const large = compute(first, second);\n".repeat(2));
  const both = [dense, large];
  // The smallest budget in which markdown holds anything at all.
  let budget = 1;
  const attempt = () => {
    try {
      return selectWithinBudget(both, { ...base, budget, format: "markdown" });
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySelectionError);
      return undefined;
    }
  };
  while (!attempt()) budget++;
  // Text alone would already hold both here: only the markdown overhead leaves out `large`.
  expect(heuristicEstimator.count(renderText(base.task, both))).toBeLessThanOrEqual(budget);

  const result = attempt()!;
  expect(ids(result)).toEqual(["dense"]);
  expect(result.skipped.map((entry) => [entry.chunkId, entry.reason])).toEqual([["large", "over-budget"]]);
  expect(heuristicEstimator.count(renderFormat("markdown", result))).toBeLessThanOrEqual(budget);
});

/** Two small chunks, then one that never fits: its skip entry only exists after the small ones were admitted. */
const prunable = () => [
  item("x", 0.9, "const x = 1;"),
  item("y", 0.8, "const y = 2;"),
  item("z", 0.7, "z ".repeat(3000)),
];

/** Budgets at which the second chunk was admitted by the greedy pass and then pruned in the final measurement. */
function pruningBudgets(candidates: SelectedChunk[]): number[] {
  const found: number[] = [];
  for (let budget = 1; budget < 1500; budget++) {
    try {
      const result = selectWithinBudget(candidates, { ...base, budget, format: "json" });
      if (ids(result).join() === "x" && result.skipped.some((s) => s.chunkId === "y")) found.push(budget);
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySelectionError);
    }
  }
  return found;
}

test("the final measurement prunes the lowest-value chunk deterministically and records it", () => {
  const candidates = prunable();
  const budgets = pruningBudgets(candidates);
  expect(budgets.length).toBeGreaterThan(0);
  for (const budget of budgets) {
    const run = (input: SelectedChunk[]) => selectWithinBudget(input, { ...base, budget, format: "json" });
    const result = run(candidates);
    expect(ids(result)).toEqual(["x"]);
    const pruned = result.skipped.find((entry) => entry.chunkId === "y")!;
    expect(pruned.reason).toBe("over-budget");
    expect(pruned.relevance).toBe(0.8);
    // The minimum budget of a skipped chunk is measured on the artifact in the requested format.
    const hugeJson = result.skipped.find((entry) => entry.chunkId === "z")!.minimumBudget!;
    const hugeText = selectWithinBudget(candidates, { ...base, budget, format: "text" }).skipped.find(
      (entry) => entry.chunkId === "z",
    )!.minimumBudget!;
    expect(hugeText).toBe(heuristicEstimator.count(renderText(base.task, [candidates[2]!])));
    expect(hugeJson).toBeGreaterThan(hugeText);
    expect(result.warnings.some((warning) => warning.includes("left out"))).toBe(true);
    expect(heuristicEstimator.count(renderFormat("json", result))).toBeLessThanOrEqual(budget);
    expect(run(candidates)).toEqual(result);
    expect(run([...candidates].reverse())).toEqual(result);
  }
});

test("pruning removes the lowest relevance first, not the last chosen", () => {
  // Same shape, but the low-relevance chunk is the denser one, so it is chosen first and must still be pruned first.
  const candidates = [
    item("x", 0.9, "const x = 1; const another = 2; const more = 3;"),
    item("y", 0.6, "y"),
    ...prunable().slice(2),
  ];
  let sawPrune = false;
  for (let budget = 1; budget < 1500; budget++) {
    try {
      const result = selectWithinBudget(candidates, { ...base, budget, format: "json" });
      for (const entry of result.skipped) {
        if (entry.chunkId === "x") expect(ids(result)).not.toContain("y");
        if (entry.chunkId === "y") sawPrune = true;
      }
    } catch (error) {
      expect(error).toBeInstanceOf(EmptySelectionError);
    }
  }
  expect(sawPrune).toBe(true);
});

test("pruning the last chunk never yields a successful empty artifact", () => {
  const candidates = [item("x", 0.9, "const x = 1;"), item("z", 0.7, "z ".repeat(3000))];
  let fitted = 0;
  for (const format of FORMATS) {
    for (let budget = 1; budget < 1500; budget++) {
      try {
        const result = selectWithinBudget(candidates, { ...base, budget, format });
        fitted++;
        expect(result.chunks.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(EmptySelectionError);
      }
    }
  }
  expect(fitted).toBeGreaterThan(0);
});

describe("the measurement loops are bounded", () => {
  // Digits in the artifact change its size unpredictably, so the embedded metrics never settle.
  const adversarial: TokenEstimator = {
    id: "adversarial",
    count(text) {
      let sum = 0;
      for (const char of text) if (char >= "0" && char <= "9") sum += (char.charCodeAt(0) - 48) * 7;
      return Math.ceil(text.length / 4) + (sum % 13);
    },
  };

  for (const format of FORMATS) {
    test(`${format}: terminates and either fits or reports that nothing fits`, () => {
      const candidates = [
        item("x", 0.9, "const x = 1;"),
        item("y", 0.8, "const y = 2;"),
        item("z", 0.7, "const z = 3;"),
      ];
      let fitted = 0;
      for (let budget = 1; budget < 1200; budget += 7) {
        try {
          const result = selectWithinBudget(candidates, { ...base, estimator: adversarial, budget, format });
          fitted++;
          const text = renderFormat(format, result);
          expect(adversarial.count(text)).toBeLessThanOrEqual(budget);
          // Whatever the loop settled on, the embedded numbers never under-report the artifact they sit in.
          expect(result.estimatedTokens).toBeGreaterThanOrEqual(adversarial.count(text));
          expect(result.characters).toBeGreaterThanOrEqual(text.length);
          expect(result.lines).toBeGreaterThanOrEqual(text.split("\n").length);
        } catch (error) {
          expect(error).toBeInstanceOf(EmptySelectionError);
        }
      }
      expect(fitted).toBeGreaterThan(0);
    });
  }
});

describe("the CLI", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
    return { io, stdout: () => out.join(""), stderr: () => err.join("") };
  };

  for (const format of FORMATS) {
    test(`--format ${format} output never exceeds --budget`, async () => {
      let printed = 0;
      for (const budget of [300, 900, 2500, 3500, 5000, 8000]) {
        const run = capture();
        const code = await main(
          [
            "Show each invoice's due date in the invoice list",
            "--repo",
            MIXED,
            "--no-jev",
            "--format",
            format,
            "--budget",
            String(budget),
          ],
          run.io,
        );
        if (code === 0) {
          printed++;
          expect(heuristicEstimator.count(run.stdout())).toBeLessThanOrEqual(budget);
        } else {
          expect(run.stdout()).toBe("");
          expect(run.stderr()).toContain("raise --budget");
        }
      }
      expect(printed).toBeGreaterThan(0);
    });
  }
});
