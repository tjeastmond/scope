import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMATS, renderFormat } from "../src/output/index.ts";
import { renderJson } from "../src/output/json.ts";
import { longestBacktickRun, renderMarkdown } from "../src/output/markdown.ts";
import { runScope } from "../src/scope.ts";
import type { ScopeRegion, ScopeResult, SelectedChunk } from "../src/types.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "fixtures/mixed-app");
const TASK = "Validate invoice totals when creating an invoice";

const schema = JSON.parse(await readFile(join(ROOT, "docs/scope-result.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);

async function fixtureResult(noJev: boolean): Promise<ScopeResult> {
  const provider = noJev ? undefined : fakeProvider({ fallback: 0.8 });
  const { result } = await runScope({ task: TASK, repo: FIXTURE, noJev, provider });
  return result;
}

/** Independent CommonMark-style reader: fenced blocks (opening fence, first closing fence of >= length) and headings. */
function parseMarkdown(markdown: string) {
  const fences: { fence: string; info: string; content: string }[] = [];
  const headings: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})([^`]*)$/.exec(lines[i]!);
    if (!open) {
      if (/^#{1,6} /.test(lines[i]!)) headings.push(lines[i]!);
      continue;
    }
    const length = open[1]!.length;
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (new RegExp(`^\`{${length},}[ \\t]*$`).test(lines[i]!)) {
        closed = true;
        break;
      }
      body.push(lines[i]!);
    }
    expect(closed).toBe(true);
    fences.push({ fence: open[1]!, info: open[2]!.trim(), content: body.join("\n") });
  }
  return { fences, headings };
}

const HOSTILE = [
  "plain",
  "```\nnot a close\n```",
  "x ```````` y",
  "~~~\ntilde\n~~~",
  "\u001b[31mred\u001b[0m",
  "nul\u0000byte",
  "sep\u2028and\u2029para",
  "\uFEFFbom first",
  "crlf\r\nline\r\n",
  "trailing cr\r",
  `${"a".repeat(200_000)}`,
  "héllo wörld \u{1F600} 日本語",
  "`",
  "``` at end ```",
];

function hostileResult(overrides: Partial<ScopeResult> = {}): ScopeResult {
  const chunks: SelectedChunk[] = [];
  const regions: ScopeRegion[] = HOSTILE.map((content, i) => {
    const id = `id-${i}`;
    chunks.push({
      chunk: {
        id,
        file: `src/f${i}.ts`,
        language: "typescript",
        kind: "function",
        name: `fn${i}`,
        startLine: 1,
        endLine: 1,
        content,
        references: [],
        estimatedTokens: 1,
      },
      signals: {},
      relevance: 0.5,
      score: 0.5,
      reason: "test",
    });
    return { file: `src/f${i}.ts`, language: "typescript", startLine: 1, endLine: 1, content, chunkIds: [id] };
  });
  return {
    schemaVersion: 1,
    mode: "no-jev",
    task: "hostile ``` task\nwith `ticks` and\r\nnewlines\u0000",
    budget: 100,
    estimator: "est",
    estimatedTokens: 5,
    characters: 10,
    lines: 20,
    chunks,
    regions,
    warnings: [],
    unmetCoherence: [],
    skipped: [],
    ...overrides,
  };
}

describe("one result, three formats", () => {
  test.each([[true], [false]])("renders text, markdown and json from the same result (noJev %p)", async (noJev) => {
    const result = await fixtureResult(noJev);
    expect(result.regions.length).toBeGreaterThan(0);
    const [text, markdown, json] = FORMATS.map((format) => renderFormat(format, result));
    expect(text).toStartWith("Scope context for: ");
    expect(markdown).toStartWith("# Scope context\n");
    const parsed = JSON.parse(json!);
    for (const region of result.regions) {
      expect(text).toContain(`${region.file}:${region.startLine}-${region.endLine}`);
      expect(markdown).toContain(`${region.file}:${region.startLine}-${region.endLine}`);
      expect(markdown).toContain(region.content);
      expect(text).toContain(region.content);
    }
    expect(parsed.regions).toHaveLength(result.regions.length);
    expect(parsed.mode).toBe(noJev ? "no-jev" : "jev");
  });

  test("markdown shows relevance for judged chunks and score for unjudged ones, never a probability", async () => {
    const jev = renderMarkdown(await fixtureResult(false));
    expect(jev).toContain("relevance 0.");
    expect(jev).not.toMatch(/probab/i);
    expect(renderMarkdown(await fixtureResult(true))).toMatch(/score \d\.\d\d/);
  });

  test("rendering is deterministic", async () => {
    const result = await fixtureResult(false);
    for (const format of FORMATS) expect(renderFormat(format, result)).toBe(renderFormat(format, result));
    const again = await fixtureResult(false);
    expect(renderJson(again)).toBe(renderJson(result));
    expect(renderMarkdown(again)).toBe(renderMarkdown(result));
  });
});

describe("JSON contract", () => {
  test.each([[true], [false]])("validates against the schema (noJev %p)", async (noJev) => {
    const payload = JSON.parse(renderJson(await fixtureResult(noJev)));
    expect(validate(payload)).toBe(true);
  });

  test("hostile and skipped/unmet data validates", () => {
    const result = hostileResult({
      skipped: [
        {
          chunkId: "s",
          file: "a.ts",
          startLine: 1,
          endLine: 2,
          score: 0.2,
          estimatedTokens: 9,
          reason: "over-budget",
          minimumBudget: 120,
        },
      ],
      unmetCoherence: [{ chunkId: "id-0", requiredId: "id-1", reason: "too-large" }],
      retrievalConfigVersion: "v1",
    });
    result.chunks[0]!.supportFor = ["id-1"];
    const payload = JSON.parse(renderJson(result));
    expect(validate(payload)).toBe(true);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutations: [string, (p: Record<string, any>) => void][] = [
    ["an extra top-level key", (p) => (p.extra = 1)],
    ["an extra key on a region", (p) => (p.regions[0].extra = 1)],
    ["an extra key on a chunk", (p) => (p.regions[0].chunks[0].extra = 1)],
    ["a wrong schemaVersion", (p) => (p.schemaVersion = 2)],
    ["a missing field", (p) => delete p.estimatedTokens],
    ["a missing region content", (p) => delete p.regions[0].content],
    ["an unknown mode", (p) => (p.mode = "other")],
    ["a relevance above 1", (p) => (p.regions[0].chunks[0].relevance = 1.5)],
  ];
  test.each(mutations)("rejects %s", async (_name, mutate) => {
    const payload = JSON.parse(renderJson(await fixtureResult(false)));
    mutate(payload);
    expect(validate(payload)).toBe(false);
  });

  test("rejects an unknown skip reason and an extra key on a skipped entry", () => {
    const base = {
      chunkId: "s",
      file: "a.ts",
      startLine: 1,
      endLine: 2,
      score: 0.2,
      estimatedTokens: 9,
      reason: "over-budget",
    };
    const payload = JSON.parse(renderJson(hostileResult({ skipped: [{ ...base, reason: "over-budget" }] })));
    payload.skipped[0].reason = "nope";
    expect(validate(payload)).toBe(false);
    payload.skipped[0].reason = "over-budget";
    payload.skipped[0].extra = true;
    expect(validate(payload)).toBe(false);
  });

  test("content lives once on the region and key order is fixed", async () => {
    const result = await fixtureResult(false);
    const json = renderJson(result);
    const payload = JSON.parse(json);
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "mode",
      "task",
      "budget",
      "estimator",
      "estimatedTokens",
      "characters",
      "lines",
      "regions",
      "warnings",
      "unmetCoherence",
      "skipped",
      ...(result.retrievalConfigVersion === undefined ? [] : ["retrievalConfigVersion"]),
    ]);
    expect(Object.keys(payload.regions[0])).toEqual(["file", "language", "startLine", "endLine", "content", "chunks"]);
    expect(Object.keys(payload.regions[0].chunks[0])).toEqual(
      ["id", "name", "kind", "relevance", "score", "reason", "supportFor"].filter(
        (key) => key in payload.regions[0].chunks[0],
      ),
    );
    expect(json).toEndWith("}\n");
    // Chunk entries carry provenance only: no source text, signals or origin.
    for (const region of payload.regions)
      for (const chunk of region.chunks) {
        expect(chunk).not.toHaveProperty("content");
        expect(chunk).not.toHaveProperty("signals");
        expect(chunk).not.toHaveProperty("origin");
      }
    // No chunk body is duplicated: each region's content appears exactly once in the document.
    for (const region of payload.regions) {
      const encoded = JSON.stringify(region.content);
      expect(json.split(encoded).length - 1).toBe(
        payload.regions.filter((r: { content: string }) => r.content === region.content).length,
      );
    }
  });

  test("region content equals the real source lines startLine..endLine", async () => {
    const payload = JSON.parse(renderJson(await fixtureResult(false)));
    for (const region of payload.regions) {
      const source = await readFile(join(FIXTURE, region.file), "utf8");
      expect(region.content).toBe(
        source
          .split("\n")
          .slice(region.startLine - 1, region.endLine)
          .join("\n"),
      );
    }
  });

  test("hostile content round trips exactly", () => {
    const result = hostileResult();
    const payload = JSON.parse(renderJson(result));
    expect(payload.regions.map((r: { content: string }) => r.content)).toEqual(HOSTILE);
    expect(payload.task).toBe(result.task);
    expect(validate(payload)).toBe(true);
  });
});

describe("Markdown fences", () => {
  test("hostile content round trips through an independent fence parser", () => {
    const result = hostileResult();
    const { fences, headings } = parseMarkdown(renderMarkdown(result));
    // The task block comes first, then one block per region.
    expect(fences).toHaveLength(HOSTILE.length + 1);
    expect(fences[0]!.content).toBe(result.task);
    expect(headings.filter((h) => h.startsWith("## "))).toHaveLength(HOSTILE.length);
    HOSTILE.forEach((content, i) => {
      const found = fences[i + 1]!;
      expect(found.content).toBe(content);
      expect(found.info).toBe("typescript");
      expect(found.fence.length).toBeGreaterThan(longestBacktickRun(content));
      expect(found.fence.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("the fence is exactly one longer than the longest run, and 3 when there are no backticks", () => {
    const render = (content: string) => {
      const result = hostileResult();
      result.regions = [{ ...result.regions[0]!, content }];
      return parseMarkdown(renderMarkdown(result)).fences[1]!.fence.length;
    };
    expect(render("no ticks")).toBe(3);
    expect(render("a ` b")).toBe(3);
    expect(render("a `` b")).toBe(3);
    expect(render("a ``` b")).toBe(4);
    expect(render("a ````````` b")).toBe(10);
  });

  test("hostile paths and symbol names cannot break the structure", () => {
    const result = hostileResult();
    const nasty = [
      "a`b.ts",
      "x\n## injected\n```\nboom",
      "``` `` ` ",
      "\u2028\r\u0000## sneaky",
      "`leading",
      "trailing`",
    ];
    result.regions = result.regions.slice(0, nasty.length).map((region, i) => ({ ...region, file: nasty[i]! }));
    result.chunks = result.chunks.slice(0, nasty.length).map((item, i) => ({
      ...item,
      chunk: { ...item.chunk, file: nasty[i]!, name: nasty[(i + 1) % nasty.length]! },
    }));
    result.warnings = ["warn\n## fake heading\n```"];
    result.estimator = "est`\n# nope";
    const markdown = renderMarkdown(result);
    const { fences, headings } = parseMarkdown(markdown);
    expect(fences).toHaveLength(nasty.length + 1);
    expect(headings.filter((h) => h.startsWith("## ") && h !== "## Warnings")).toHaveLength(nasty.length);
    expect(headings.filter((h) => h.startsWith("# "))).toEqual(["# Scope context"]);
    expect(markdown).not.toContain("\n## injected");
    expect(markdown).not.toContain("\n## fake heading");
    expect(markdown).not.toContain("\n# nope");
    expect(markdown).not.toContain("\n## sneaky");
    // Every region heading is one well-formed code span: the delimiter run never occurs inside the span.
    const spans = headings.filter((h) => h.startsWith("## ") && h !== "## Warnings");
    spans.forEach((heading) => {
      const match = /^## (`+) (.*) \1$/.exec(heading)!;
      expect(match).not.toBeNull();
      const inner = match[2]!;
      for (const run of inner.match(/`+/g) ?? []) expect(run.length).not.toBe(match[1]!.length);
    });
  });

  test("warnings are listed", () => {
    expect(renderMarkdown(hostileResult({ warnings: ["one", "two"] }))).toContain("## Warnings\n\n- one\n- two\n");
    expect(renderMarkdown(hostileResult())).not.toContain("## Warnings");
  });
});
