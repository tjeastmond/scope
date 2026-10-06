import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { EmptySelectionError } from "../src/context/select.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import { FORMATS, renderFormat, type OutputFormat } from "../src/output/index.ts";
import { runScope } from "../src/scope.ts";
import type { ScopeResult } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";
import { FIXTURES, loadLabeledTasks } from "./helpers/labels.ts";

const MIXED = join(FIXTURES, "mixed-app");
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(join(import.meta.dir, "../docs/scope-result.schema.json"), "utf8")),
);
const labeled = (await loadLabeledTasks("mixed-app"))[0]!;
const task = labeled.task;
const provider = fakeProvider({ fallback: 0.6 });

const run = (format: OutputFormat, explain: boolean, budget = 8000, noJev = false) =>
  runScope({ task, repo: MIXED, budget, noJev, format, explain, provider });

describe("--explain accounts for every selected chunk", () => {
  test.each([...FORMATS])("%s: each chunk appears in the explanation", async (format) => {
    const { result } = await run(format, true);
    expect(result.explain).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(2);
    const text = renderFormat(format, result);
    if (format === "json") {
      const payload = JSON.parse(text);
      expect(payload.explain).toBe(true);
      const chunks = payload.regions.flatMap((region: { chunks: unknown[] }) => region.chunks);
      expect(chunks.map((chunk: { id: string }) => chunk.id).sort()).toEqual(
        result.chunks.map((item) => item.chunk.id).sort(),
      );
      for (const chunk of chunks) {
        expect(chunk.signals).toBeObject();
        expect(Object.keys(chunk.signals)).toEqual(Object.keys(chunk.signals).sort());
        expect(chunk.estimatedTokens).toBeNumber();
      }
      return;
    }
    const explanation = text.slice(text.indexOf(format === "text" ? "-- Explanation --" : "## Explanation"));
    for (const { chunk } of result.chunks) {
      expect(explanation).toContain(`${chunk.file}:${chunk.startLine}-${chunk.endLine}`);
    }
    expect(explanation).toContain("Jev relevance: 0.60");
    expect(explanation).toContain("Origin: direct (dependency distance 0)");
    expect(explanation).toContain("Signals: ");
    expect(explanation).toContain("Token cost: ");
  });

  test("a supporting declaration says what it supports", async () => {
    const { result } = await run("text", true, 8000, true);
    expect(result.chunks.some((item) => item.supportFor)).toBe(true);
    expect(renderFormat("text", result)).toMatch(/Origin: supporting declaration for \S+:\d+-\d+/);
  });

  test("an expanded chunk names the chunk it was expanded from", () => {
    const base = {
      language: "typescript" as const,
      kind: "function" as const,
      startLine: 1,
      endLine: 1,
      content: "x",
      references: [],
      estimatedTokens: 1,
    };
    const parent = { ...base, id: "a.ts#a", file: "a.ts", name: "a" };
    const child = { ...base, id: "b.ts#b", file: "b.ts", name: "b" };
    const result: ScopeResult = {
      schemaVersion: 1,
      mode: "no-jev",
      task: "t",
      budget: 100,
      estimator: "e",
      estimatedTokens: 1,
      characters: 1,
      lines: 1,
      chunks: [
        { chunk: parent, signals: { path: 0.5, lexical: 0.25 }, origin: "direct", score: 1, reason: "r" },
        { chunk: child, signals: {}, origin: "expanded-from:a.ts#a", score: 0.5, reason: "r" },
      ],
      regions: [],
      warnings: [],
      unmetCoherence: [],
      skipped: [],
      explain: true,
    };
    const text = renderFormat("text", result);
    expect(text).toContain("Origin: expanded from a.ts:1-1 a (dependency distance 1)");
    expect(text).toContain("Signals: lexical 0.25, path 0.50");
  });

  test("below-threshold skips are listed individually, capped, only under explain", async () => {
    const judge = fakeProvider({
      relevance: Object.fromEntries(labeled.required.map((label) => [label.split("::")[1]!, 0.9])),
      fallback: 0.05,
    });
    const plain = (await runScope({ task, repo: MIXED, provider: judge })).result;
    const explained = (await runScope({ task, repo: MIXED, provider: judge, explain: true })).result;
    const below = explained.skipped.filter((entry) => entry.reason === "below-threshold").length;
    expect(below).toBeGreaterThan(5);
    expect(renderFormat("text", plain)).toContain(`${below} candidate(s) scored below the relevance minimum`);
    const more = `and ${below - 5} more below the relevance minimum`;
    expect(renderFormat("text", explained)).toContain("-- Left out (below relevance minimum) --");
    expect(renderFormat("text", explained)).toContain(more);
    expect(renderFormat("markdown", explained)).toContain(more);
  });
});

describe("explain output counts toward the budget", () => {
  for (const noJev of [true, false]) {
    test.each([...FORMATS])(
      `${noJev ? "no-jev" : "jev"} / %s: every budget fits with explain on`,
      async (format) => {
        let produced = 0;
        for (const budget of [25, 100, 200, 300, 400, 600, 800, 1200, 2000, 3000, 4500, 8000, 12000, 20000]) {
          let result: ScopeResult;
          try {
            ({ result } = await run(format, true, budget, noJev));
          } catch (error) {
            expect(error).toBeInstanceOf(EmptySelectionError);
            continue;
          }
          produced++;
          const tokens = heuristicEstimator.count(renderFormat(format, result));
          expect(tokens).toBeLessThanOrEqual(budget);
          expect(result.estimatedTokens).toBe(tokens);
        }
        expect(produced).toBeGreaterThan(2);
      },
      60_000,
    );
  }

  test.each([...FORMATS])("%s: a budget that fits without explain yields fewer chunks with it", async (format) => {
    const plain = (await run(format, false, 4000)).result;
    const explained = (await run(format, true, plain.estimatedTokens)).result;
    expect(explained.estimatedTokens).toBeLessThanOrEqual(plain.estimatedTokens);
    expect(explained.chunks.length).toBeLessThan(plain.chunks.length);
  });
});

test("JSON with explain validates against the schema; without it there are no explain keys", async () => {
  expect(validate(JSON.parse(renderFormat("json", (await run("json", true)).result)))).toBe(true);
  const plain = renderFormat("json", (await run("json", false)).result);
  expect(validate(JSON.parse(plain))).toBe(true);
  expect(plain).not.toContain('"signals"');
  expect(plain).not.toContain('"explain"');
});

test("without --explain the text and Markdown artifacts have no explanation", async () => {
  expect(renderFormat("text", (await run("text", false)).result)).not.toContain("Explanation");
  expect(renderFormat("markdown", (await run("markdown", false)).result)).not.toContain("Explanation");
});

test("Markdown explanation cannot be broken out of by hostile names, paths and reasons", () => {
  const hostile = "evil`\n## Injected\n```\n# also";
  const file = `src/${hostile}.ts`;
  const result: ScopeResult = {
    schemaVersion: 1,
    mode: "no-jev",
    task: "t",
    budget: 1000,
    estimator: "e",
    estimatedTokens: 10,
    characters: 10,
    lines: 10,
    chunks: [
      {
        chunk: {
          id: hostile,
          file,
          language: "typescript",
          kind: "function",
          name: hostile,
          startLine: 1,
          endLine: 1,
          content: "const a = 1;",
          references: [],
          estimatedTokens: 3,
        },
        signals: {},
        origin: `expanded-from:${hostile}`,
        score: 1,
        reason: `reason ${hostile}`,
      },
    ],
    regions: [{ file, language: "typescript", startLine: 1, endLine: 1, content: "const a = 1;", chunkIds: [hostile] }],
    warnings: [],
    unmetCoherence: [],
    skipped: [],
    explain: true,
  };
  const markdown = renderFormat("markdown", result);
  for (const heading of markdown.split("\n").filter((line) => line.startsWith("#"))) {
    expect(heading).toMatch(/^(# Scope context|## Explanation|##+ `+ .* `+)$/);
  }
  expect(markdown).not.toMatch(/^## Injected/m);
  expect(markdown).not.toMatch(/^# also/m);
  expect(renderFormat("text", result).split("-- Explanation --")[1]).not.toMatch(/^## Injected/m);
});
