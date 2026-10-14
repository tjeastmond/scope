import { describe, expect, test } from "bun:test";
import { mergeRegions, toScopeRegion } from "../src/context/regions.ts";
import { renderFormat } from "../src/output/index.ts";
import { byLocation } from "../src/output/text.ts";
import type { ScopeResult, SelectedChunk } from "../src/types.ts";

function item(file: string, startLine: number, relevance: number | undefined, score = 0.5): SelectedChunk {
  const name = `fn_${file.replace(/\W/g, "_")}_${startLine}`;
  return {
    chunk: {
      id: `${file}#${startLine}`,
      file,
      language: "typescript",
      kind: "function",
      name,
      startLine,
      endLine: startLine,
      content: `// body of ${name}`,
      references: [],
    },
    signals: { lexical: 0.3 },
    ...(relevance === undefined ? {} : { relevance }),
    score,
    reason: "unique-reason-text",
  };
}

function build(chunks: SelectedChunk[], overrides: Partial<ScopeResult> = {}): ScopeResult {
  const sorted = [...chunks].sort(byLocation);
  return {
    schemaVersion: 4,
    mode: "jev",
    task: "t",
    chunks: sorted,
    regions: mergeRegions(sorted).map(toScopeRegion),
    warnings: [],
    skipped: [],
    ...overrides,
  };
}

const skip = (file: string, relevance: number) => ({
  chunkId: `${file}#s`,
  file,
  startLine: 1,
  endLine: 2,
  relevance,
  score: relevance,
});

const ranked = [item("a.ts", 1, 0.3), item("b.ts", 1, 0.9), item("c.ts", 1, 0.9), item("d.ts", 1, 0.6)];

describe("regions are ordered strongest first", () => {
  test("JSON orders by region relevance, ties by path, and reports the region relevance", () => {
    const payload = JSON.parse(renderFormat("json", build(ranked)));
    expect(payload.regions.map((r: { file: string }) => r.file)).toEqual(["b.ts", "c.ts", "d.ts", "a.ts"]);
    expect(payload.regions.map((r: { relevance: number }) => r.relevance)).toEqual([0.9, 0.9, 0.6, 0.3]);
  });

  test("a region takes the highest relevance among its merged chunks", () => {
    const merged = [item("a.ts", 1, 0.2), item("a.ts", 2, 0.8), item("z.ts", 1, 0.5)];
    const payload = JSON.parse(renderFormat("json", build(merged)));
    expect(payload.regions.map((r: { file: string }) => r.file)).toEqual(["a.ts", "z.ts"]);
    expect(payload.regions[0].relevance).toBe(0.8);
  });

  test("Markdown and text use the same order", () => {
    const result = build(ranked);
    const order = (out: string) => [...out.matchAll(/([a-d])\.ts:1-1/g)].map((m) => m[1]).join("");
    expect(order(renderFormat("markdown", result))).toBe("bcda");
    expect(order(renderFormat("text", result))).toBe("bcda");
  });

  test("without Jev, regions order by score and carry no relevance", () => {
    const result = build([item("a.ts", 1, undefined, 0.2), item("b.ts", 1, undefined, 0.9)], { mode: "no-jev" });
    const payload = JSON.parse(renderFormat("json", result));
    expect(payload.regions.map((r: { file: string }) => r.file)).toEqual(["b.ts", "a.ts"]);
    expect(payload.regions[0]).not.toHaveProperty("relevance");
  });
});

describe("JSON drops metadata unless --explain", () => {
  test("chunk entries carry no score, reason, signals or origin by default", () => {
    const payload = JSON.parse(renderFormat("json", build(ranked)));
    expect(Object.keys(payload.regions[0].chunks[0])).toEqual([
      "id",
      "name",
      "kind",
      "startLine",
      "endLine",
      "relevance",
    ]);
    expect(JSON.stringify(payload)).not.toContain("unique-reason-text");
    expect(payload).not.toHaveProperty("explain");
  });

  test("--explain restores score and reason", () => {
    const payload = JSON.parse(renderFormat("json", build(ranked, { explain: true })));
    const chunk = payload.regions[0].chunks[0];
    expect(chunk.score).toBe(0.5);
    expect(chunk.reason).toBe("unique-reason-text");
    expect(chunk.signals).toEqual({ lexical: 0.3 });
  });
});

describe("JSON skipped list is gated by --explain", () => {
  const skipped = [skip("low.ts", 0.05), skip("high.ts", 0.45), skip("mid.ts", 0.2)];

  test("omitted by default", () => {
    const payload = JSON.parse(renderFormat("json", build(ranked, { skipped })));
    expect(payload).not.toHaveProperty("skipped");
  });

  test("listed most relevant first under --explain", () => {
    const payload = JSON.parse(renderFormat("json", build(ranked, { skipped, explain: true })));
    expect(payload.skipped.map((s: { file: string }) => s.file)).toEqual(["high.ts", "mid.ts", "low.ts"]);
  });
});
