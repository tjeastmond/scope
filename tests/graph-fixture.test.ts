import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildGraph, type RepositoryGraph } from "../src/graph/graph.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

const ROOT = join(import.meta.dir, "../fixtures/mixed-app");

let chunks: CodeChunk[];
let graph: RepositoryGraph;

beforeAll(async () => {
  chunks = (await loadChunks(ROOT)).chunks;
  graph = buildGraph(chunks);
});

const chunk = (file: string, name: string): CodeChunk => {
  const found = chunks.find((c) => c.file === file && c.name === name);
  if (!found) throw new Error(`no chunk ${file}::${name}`);
  return found;
};
const edge = (file: string, name: string, imported: string) =>
  graph.outgoing(chunk(file, name).id).find((e) => e.name === imported);

describe("the default resolver on the mixed fixture", () => {
  test("InvoiceRow reaches InvoiceDto through a resolved, exact edge", () => {
    expect(edge("web/src/components/InvoiceRow.tsx", "InvoiceRow", "InvoiceDto")).toMatchObject({
      to: chunk("web/src/hooks/useInvoices.ts", "InvoiceDto").id,
      confidence: "exact",
      evidence:
        'import "../hooks/useInvoices" resolved to web/src/hooks/useInvoices.ts (extension .ts appended); InvoiceDto is a chunk there',
    });
    expect(edge("web/src/components/InvoiceRow.tsx", "InvoiceRow", "format")?.to).toBe(
      chunk("web/src/lib/format.ts", "format").id,
    );
  });

  test("a stylesheet import resolves to the file", () => {
    expect(edge("web/src/components/InvoiceRow.tsx", "InvoiceRow", "default")).toMatchObject({
      toFile: "web/src/styles/invoice.module.css",
      confidence: "heuristic",
    });
  });

  test("api imports resolve to the model, service and routes", () => {
    const route = chunk("api/src/server.ts", "route");
    expect(edge("api/src/server.ts", "route", "handleHealth")?.to).toBe(
      chunk("api/src/routes/health.ts", "handleHealth").id,
    );
    expect(graph.neighbors(route.id).map((n) => n.chunkId)).toContain(
      chunk("api/src/routes/invoices.ts", "handleInvoices").id,
    );
    expect(edge("api/src/services/invoiceService.ts", "InvoiceService", "Billing")?.to).toBe(
      chunk("api/src/models/invoice.ts", "Billing").id,
    );
  });

  test("python imports resolve to local modules in worker/", () => {
    expect(edge("worker/main.py", "run_once", "send_reminder")?.to).toBe(chunk("worker/tasks.py", "send_reminder").id);
    expect(edge("worker/main.py", "run_once", "ReminderQueue")?.to).toBe(
      chunk("worker/queue_client.py", "ReminderQueue").id,
    );
    const format = graph.edges.find((e) => e.fromFile === "worker/tasks.py" && e.name === "format");
    expect(format).toMatchObject({ toFile: "worker/format.py", to: chunk("worker/format.py", "format").id });
  });

  test("a test file's imports and naming link it to its sources", () => {
    const imported = graph.edges.find((e) => e.fromFile === "api/tests/invoiceService.test.ts" && e.kind === "import");
    expect(imported?.name).toBe("InvoiceService");
    expect(imported).toMatchObject({ to: chunk("api/src/services/invoiceService.ts", "InvoiceService").id });
    expect(graph.sourcesFor("api/tests/invoiceService.test.ts")).toContain("api/src/services/invoiceService.ts");
    expect(graph.sourcesFor("web/tests/format.test.ts")).toEqual(["web/src/lib/format.ts"]);
    expect(graph.sourcesFor("worker/tests/test_tasks.py")).toContain("worker/tasks.py");
  });

  test("external packages stay dangling", () => {
    const react = graph.edges.filter((e) => e.specifier === "react");
    expect(react.length).toBeGreaterThan(0);
    expect(react.every((e) => e.confidence === "unresolved" && e.evidence === "bare package specifier")).toBe(true);
  });
});
