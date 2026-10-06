import { beforeAll, describe, expect, test } from "bun:test";
import { join, posix } from "node:path";
import { buildGraph, type GraphEdge, type ImportResolver, type RepositoryGraph } from "../src/graph/graph.ts";
import { isTestFile } from "../src/graph/tests.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

const ROOT = join(import.meta.dir, "../fixtures/mixed-app");

/** A tiny stand-in resolver: relative specifiers by path join, absolute Python modules inside the top-level dir. */
function testResolver(files: ReadonlySet<string>): ImportResolver {
  return ({ file, language }, specifier) => {
    const base = specifier.startsWith(".")
      ? posix.join(posix.dirname(file), specifier)
      : language === "python"
        ? posix.join(file.split("/")[0]!, specifier)
        : undefined;
    const found = base && [base, `${base}.ts`, `${base}.tsx`, `${base}.py`].find((candidate) => files.has(candidate));
    return found ? { file: found } : { unresolved: `test resolver found nothing for ${specifier}` };
  };
}

let chunks: CodeChunk[];
let graph: RepositoryGraph;

beforeAll(async () => {
  chunks = (await loadChunks(ROOT)).chunks;
  graph = buildGraph(chunks, { resolveImport: testResolver(new Set(chunks.map((c) => c.file))) });
});

const chunk = (file: string, name: string): CodeChunk => {
  const found = chunks.find((c) => c.file === file && c.name === name);
  if (!found) throw new Error(`no chunk ${file}::${name}`);
  return found;
};
const edgesFrom = (file: string, name: string): GraphEdge[] => [...graph.outgoing(chunk(file, name).id)];

describe("import edges", () => {
  test("a used import resolves to the chunk it names, with evidence", () => {
    const dto = chunk("web/src/hooks/useInvoices.ts", "InvoiceDto");
    const edge = edgesFrom("web/src/components/InvoiceRow.tsx", "InvoiceRow").find((e) => e.name === "InvoiceDto");
    expect(edge).toMatchObject({ kind: "import", to: dto.id, toFile: dto.file, confidence: "exact" });
    expect(edge?.evidence).toBe(
      'import "../hooks/useInvoices" resolved to web/src/hooks/useInvoices.ts; InvoiceDto is a chunk there',
    );
  });

  test("a file-level import creates edges only from the chunks that mention the name", () => {
    const fromInvoiceService = (name: string) => edgesFrom("api/src/services/invoiceService.ts", name);
    expect(fromInvoiceService("InvoiceService").some((e) => e.name === "Billing")).toBe(true);
    // The import is attached to every chunk of the file, but only the class mentions Billing as a whole word.
    const row = edgesFrom("web/src/components/InvoiceList.tsx", "InvoiceList");
    expect(row.map((e) => e.name)).toContain("InvoiceRow");
    expect(row.map((e) => e.name)).not.toContain("InvoiceDto");
    expect(edgesFrom("web/src/components/InvoiceList.tsx", "InvoiceListProps").map((e) => e.name)).toContain(
      "InvoiceDto",
    );
  });

  test("a whole-module import points at the file, heuristically", () => {
    const edge = edgesFrom("web/src/components/InvoiceRow.tsx", "InvoiceRow").find((e) => e.name === "default");
    expect(edge).toMatchObject({ toFile: "web/src/styles/invoice.module.css", confidence: "heuristic" });
    expect(edge?.to).toBeUndefined();
    expect(edge?.evidence).toContain("a whole-module import");
  });

  test("bare packages stay as dangling edges with the resolver's reason", () => {
    const edge = graph.edges.find((e) => e.fromFile === "web/src/hooks/useInvoices.ts" && e.name === "useState");
    expect(edge).toMatchObject({ confidence: "unresolved", specifier: "react" });
    expect(edge?.to).toBeUndefined();
    expect(edge?.toFile).toBeUndefined();
    expect(edge?.evidence).toContain("found nothing");
  });

  test("python imports resolve to module chunks and unused names are still kept", () => {
    const schedule = chunk("worker/tests/test_tasks.py", "test_schedule_orders_by_attempts");
    const target = chunk("worker/tasks.py", "schedule");
    expect(graph.outgoing(schedule.id).find((e) => e.name === "schedule")).toMatchObject({ to: target.id });
    expect(graph.edges.some((e) => e.fromFile === "worker/main.py" && e.name === "logging")).toBe(true);
  });

  test("a default resolver reports that resolution is unavailable", () => {
    const bare = buildGraph(chunks);
    const edge = bare.edges.find((e) => e.kind === "import");
    expect(edge).toMatchObject({ confidence: "unresolved", evidence: "import resolution not available" });
  });

  test("dynamic imports become dangling edges", () => {
    const source = {
      ...chunk("api/src/routes/health.ts", "handleHealth"),
      id: "dyn",
      startLine: 1,
      endLine: 3,
      references: [
        {
          kind: "import" as const,
          from: { file: "api/src/routes/health.ts", line: 2 },
          name: "x + y",
          evidence: "unresolved" as const,
        },
      ],
    };
    const dynamic = buildGraph([source]);
    expect(dynamic.edges).toEqual([
      expect.objectContaining({ from: "dyn", name: "x + y", confidence: "unresolved", evidence: "dynamic specifier" }),
    ]);
  });

  test("no distinct reference is dropped", () => {
    const distinct = new Set(
      chunks.flatMap((c) => c.references.map((r) => `${c.file}|${r.kind}|${r.name}|${r.specifier ?? ""}`)),
    );
    const edged = new Set(
      graph.edges.filter((e) => e.kind !== "test").map((e) => `${e.fromFile}|${e.kind}|${e.name}|${e.specifier ?? ""}`),
    );
    expect([...distinct].filter((key) => !edged.has(key))).toEqual([]);
    expect(graph.edges.filter((e) => e.confidence === "unresolved").length).toBeGreaterThan(0);
  });
});

describe("test-to-source links", () => {
  test("recognizes test files by name and directory", () => {
    for (const path of [
      "a/x.test.ts",
      "a/x.spec.js",
      "a/test_x.py",
      "a/x_test.py",
      "a/tests/x.ts",
      "a/__tests__/x.ts",
      "test/x.py",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of ["a/x.ts", "a/testing.ts", "a/contest.py", "a/latest/x.py"])
      expect(isTestFile(path)).toBe(false);
  });

  test("a test is linked to the files it imports, exactly", () => {
    expect(graph.sourcesFor("api/tests/invoiceService.test.ts")).toEqual([
      "api/src/services/invoiceService.ts",
      "api/src/util/validate.ts",
    ]);
    expect(graph.testsFor("api/src/services/invoiceService.ts")).toEqual(["api/tests/invoiceService.test.ts"]);
    const edge = graph.edges.find((e) => e.kind === "test" && e.toFile === "api/src/services/invoiceService.ts");
    expect(edge).toMatchObject({ confidence: "exact", evidence: expect.stringContaining("imports") });
  });

  test("python tests link by import and by name", () => {
    expect(graph.sourcesFor("worker/tests/test_tasks.py")).toContain("worker/tasks.py");
    expect(graph.testsFor("worker/tasks.py")).toEqual(["worker/tests/test_tasks.py"]);
  });

  test("naming picks the same-package file when the stem is shared, without needing an import", () => {
    const unresolved = buildGraph(chunks);
    expect(unresolved.sourcesFor("web/tests/format.test.ts")).toEqual(["web/src/lib/format.ts"]);
    expect(unresolved.testsFor("api/src/util/format.ts")).toEqual([]);
    const edge = unresolved.edges.find((e) => e.kind === "test" && e.fromFile === "web/tests/format.test.ts");
    expect(edge).toMatchObject({ confidence: "heuristic" });
    expect(edge?.evidence).toBe("test file naming convention: web/tests/format.test.ts <-> web/src/lib/format.ts");
    expect(unresolved.sourcesFor("api/tests/invoiceService.test.ts")).toEqual(["api/src/services/invoiceService.ts"]);
    expect(unresolved.sourcesFor("worker/tests/test_tasks.py")).toEqual(["worker/tasks.py"]);
  });

  test("an ambiguous name keeps every candidate and says so", () => {
    const make = (file: string, id: string): CodeChunk => ({ ...chunks[0]!, id, file, references: [], startLine: 1 });
    const ambiguous = buildGraph([make("a/x.ts", "1"), make("b/x.ts", "2"), make("t/x.test.ts", "3")]);
    expect(ambiguous.sourcesFor("t/x.test.ts")).toEqual(["a/x.ts", "b/x.ts"]);
    expect(ambiguous.edges[0]?.evidence).toContain("ambiguous");
  });

  test("a test that imports a same-stem file is not also linked by name to another", () => {
    const make = (file: string, id: string, references: CodeChunk["references"] = []): CodeChunk => ({
      ...chunks[0]!,
      id,
      file,
      references,
      startLine: 1,
    });
    const reference = {
      kind: "import" as const,
      from: { file: "t/x.test.ts", line: 1 },
      name: "x",
      specifier: "../a/x",
    };
    const graphWithImport = buildGraph(
      [make("a/x.ts", "1"), make("b/x.ts", "2"), make("t/x.test.ts", "3", [reference])],
      { resolveImport: () => ({ file: "a/x.ts" }) },
    );
    expect(graphWithImport.sourcesFor("t/x.test.ts")).toEqual(["a/x.ts"]);
  });

  test("naming only links files of the same language family", () => {
    const make = (file: string, id: string, language: CodeChunk["language"]): CodeChunk => ({
      ...chunks[0]!,
      id,
      file,
      language,
      references: [],
      startLine: 1,
    });
    const mixed = buildGraph([make("src/tasks.py", "1", "python"), make("tests/tasks.test.ts", "2", "typescript")]);
    expect(mixed.sourcesFor("tests/tasks.test.ts")).toEqual([]);
  });
});

describe("neighbors", () => {
  test("lists both directions, exact first, sorted, without self or unresolved edges", () => {
    const dto = chunk("web/src/hooks/useInvoices.ts", "InvoiceDto");
    const neighbors = graph.neighbors(dto.id);
    expect(neighbors.map((n) => n.chunkId)).toEqual(
      [
        chunk("web/src/components/InvoiceList.tsx", "InvoiceListProps"),
        chunk("web/src/components/InvoiceRow.tsx", "InvoiceRow"),
      ].map((c) => c.id),
    );
    expect(neighbors.every((n) => n.confidence === "exact" && n.evidence.includes("InvoiceDto"))).toBe(true);
    expect(neighbors.some((n) => n.chunkId === dto.id)).toBe(false);
  });

  test("incoming mirrors outgoing", () => {
    const dto = chunk("web/src/hooks/useInvoices.ts", "InvoiceDto");
    for (const edge of graph.incoming(dto.id)) expect(edge.to).toBe(dto.id);
    expect(graph.fileImports("web/src/components/InvoiceRow.tsx").map((f) => f.file)).toEqual([
      "web/src/hooks/useInvoices.ts",
      "web/src/lib/format.ts",
      "web/src/styles/invoice.module.css",
    ]);
  });
});

describe("determinism", () => {
  test("shuffled input gives identical edges", () => {
    const resolveImport = testResolver(new Set(chunks.map((c) => c.file)));
    const odd = chunks.filter((_, i) => i % 2 === 1);
    const even = chunks.filter((_, i) => i % 2 === 0);
    const reversed = buildGraph([...odd, ...even].reverse(), { resolveImport });
    expect(reversed.edges).toEqual(graph.edges);
    const id = chunk("web/src/hooks/useInvoices.ts", "InvoiceDto").id;
    expect(reversed.neighbors(id)).toEqual(graph.neighbors(id));
  });
});
