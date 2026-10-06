import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bm25,
  buildIndexes,
  lookupBasename,
  lookupPathWord,
  lookupSymbolExact,
  lookupSymbolWord,
  scoreText,
  type RetrievalIndexes,
} from "../src/retrieval/indexes.ts";
import { tokenizeText } from "../src/retrieval/terms.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

const ROOT = join(import.meta.dir, "../fixtures/mixed-app");
const { chunks } = await loadChunks(ROOT);
const indexes = buildIndexes(chunks);

function label(ix: RetrievalIndexes, ids: string[]): string[] {
  return ids.map((id) => {
    const found = ix.byId.get(id)!;
    return `${found.file}:${found.name ?? ""}`;
  });
}

function chunk(id: string, file: string, content: string, name?: string): CodeChunk {
  return {
    id,
    file,
    language: "typescript",
    kind: "function",
    name,
    startLine: 1,
    endLine: 1,
    content,
    references: [],
  };
}

describe("chunk order", () => {
  test("sorts by file, start line, then id regardless of input order", () => {
    const ix = buildIndexes([chunk("b", "z.ts", ""), chunk("c", "a.ts", ""), chunk("a", "a.ts", "")]);
    expect(ix.chunks.map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(ix.byId.get("b")?.file).toBe("z.ts");
  });

  test("handles empty input", () => {
    const ix = buildIndexes([]);
    expect(ix.chunks).toEqual([]);
    expect(ix.text.avgDocLength).toBe(0);
    expect(lookupSymbolExact(ix, "x")).toEqual([]);
    expect(scoreText(ix, ["x"]).size).toBe(0);
  });
});

describe("symbol index on the mixed fixture", () => {
  test("finds methods by exact name in any style", () => {
    for (const term of ["listByStatus", "list_by_status", "LISTBYSTATUS"]) {
      expect(label(indexes, lookupSymbolExact(indexes, term))).toContain(
        "api/src/services/invoiceService.ts:InvoiceService.listByStatus",
      );
    }
    expect(label(indexes, lookupSymbolExact(indexes, "dueDateFrom"))).toContain(
      "api/src/services/invoiceService.ts:InvoiceService.dueDateFrom",
    );
  });

  test("matches a qualified name by its joined form", () => {
    const qualified = lookupSymbolExact(indexes, "InvoiceService.listByStatus");
    expect(qualified).not.toEqual([]);
    expect(lookupSymbolExact(indexes, "invoiceservicelistbystatus")).toEqual(qualified);
  });

  test("finds symbols by a single name word, but not by exact lookup", () => {
    expect(label(indexes, lookupSymbolWord(indexes, "status"))).toContain(
      "api/src/services/invoiceService.ts:InvoiceService.listByStatus",
    );
    expect(lookupSymbolExact(indexes, "status")).not.toContain(lookupSymbolExact(indexes, "listByStatus")[0]!);
  });

  test("returns nothing for unknown names", () => {
    expect(lookupSymbolExact(indexes, "noSuchSymbolAnywhere")).toEqual([]);
    expect(lookupSymbolWord(indexes, "zzzqqq")).toEqual([]);
  });
});

describe("path index on the mixed fixture", () => {
  test("a path word finds files with that directory or file name word", () => {
    const files = lookupPathWord(indexes, "invoices");
    expect(files).toContain("api/src/routes/invoices.ts");
    expect(files).toContain("db/migrations/001_create_invoices.sql");
    expect(files).toContain("web/src/components/InvoiceList.tsx");
    expect(files).not.toContain("api/src/util/csv.ts");
  });

  test("looks up by base name with or without extension", () => {
    expect(lookupBasename(indexes, "tasks.py")).toEqual(["worker/tasks.py"]);
    expect(lookupBasename(indexes, "Tasks")).toContain("worker/tasks.py");
    expect(lookupBasename(indexes, "format")).toEqual(
      expect.arrayContaining(["api/src/util/format.ts", "web/src/lib/format.ts", "worker/format.py"]),
    );
  });

  test("lists chunk ids per file in chunk order", () => {
    const ids = indexes.paths.chunksByFile.get("api/src/services/invoiceService.ts")!;
    const starts = ids.map((id) => indexes.byId.get(id)!.startLine);
    expect(ids.length).toBeGreaterThan(1);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("text index and BM25", () => {
  test("a term finds the worker task chunks that mention it", () => {
    const scores = scoreText(indexes, tokenizeText("retry"));
    const files = new Set([...scores.keys()].map((id) => indexes.byId.get(id)!.file));
    expect(files.has("worker/tasks.py")).toBe(true);
  });

  test("a chunk with a rare term outranks one without, and absent chunks score zero", () => {
    const ix = buildIndexes([
      chunk("a", "a.ts", "common words here and zebra"),
      chunk("b", "b.ts", "common words here only"),
      chunk("c", "c.ts", "common common words"),
    ]);
    const scores = scoreText(ix, ["common", "zebra"]);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("b")!);
    expect(bm25(ix, "zebra", "b")).toBe(0);
    expect(bm25(ix, "missing", "a")).toBe(0);
    // N=3, df=1, tf=1, dl=5, avgdl=4 -> hand-computed with k1=1.2, b=0.75.
    const idf = Math.log(1 + 2.5 / 1.5);
    const expected = (idf * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 5) / 4));
    expect(bm25(ix, "zebra", "a")).toBeCloseTo(expected, 10);
  });

  test("records postings, document lengths and average length", () => {
    const ix = buildIndexes([chunk("a", "a.ts", "foo foo bar"), chunk("b", "b.ts", "foo")]);
    expect(ix.text.postings.get("foo")).toEqual([
      { chunkId: "a", tf: 2 },
      { chunkId: "b", tf: 1 },
    ]);
    expect(ix.text.docLength.get("a")).toBe(3);
    expect(ix.text.avgDocLength).toBe(2);
    expect(ix.text.docCount).toBe(2);
  });
});

describe("singular and plural forms", () => {
  const plural = buildIndexes([chunk("p1", "src/statuses.ts", "export const statuses = [];", "statuses")]);
  test("meet in the symbol, path and text indexes", () => {
    expect(lookupSymbolWord(plural, "status")).toEqual(["p1"]);
    expect(lookupPathWord(plural, "status")).toEqual(["src/statuses.ts"]);
    expect(scoreText(plural, tokenizeText("status")).has("p1")).toBe(true);
  });
});

describe("determinism", () => {
  test("reversed input builds identical indexes", () => {
    const other = buildIndexes([...chunks].reverse());
    expect(other).toEqual(indexes);
    expect([...other.symbols.exact.keys()]).toEqual([...indexes.symbols.exact.keys()]);
    expect([...other.text.postings.keys()]).toEqual([...indexes.text.postings.keys()]);
  });
});

describe("scale", () => {
  test("builds an index over about 5,000 generated chunks quickly", () => {
    const generated: CodeChunk[] = [];
    for (let i = 0; i < 5000; i++) {
      const body = Array.from({ length: 30 }, (_, j) => `value${(i * 7 + j) % 400} compute${j % 13}Total`).join(" ");
      generated.push(chunk(`id${i}`, `pkg${i % 50}/mod${i % 200}.ts`, `function item${i}() { ${body} }`, `item${i}`));
    }
    const start = performance.now();
    const ix = buildIndexes(generated);
    const ms = performance.now() - start;
    console.log(`buildIndexes: ${generated.length} chunks in ${ms.toFixed(1)} ms`);
    expect(ix.chunks).toHaveLength(5000);
    expect(ms).toBeLessThan(5000);
  });
});
