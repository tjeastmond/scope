import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFile } from "../src/analyzers/index.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import { scanRepository, type SkippedPath } from "../src/repository/files.ts";
import { classifyFile } from "../src/repository/language.ts";
import { loadChunks } from "../src/scope.ts";
import type { CodeChunk } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const ROOT = join(FIXTURES, "mixed-app");
const CRLF_FILE = "api/src/util/csv.ts";
const BROKEN_FILE = "api/src/broken/report.ts";

interface LabeledTask {
  id: string;
  task: string;
  required: string[];
  useful: string[];
  irrelevant: string[];
}

const EXPECTED_ELIGIBLE = [
  "README.md",
  "api/src/broken/report.ts",
  "api/src/i18n/messages.ts",
  "api/src/models/invoice.ts",
  "api/src/routes/health.ts",
  "api/src/routes/invoices.ts",
  "api/src/server.ts",
  "api/src/services/invoiceService.ts",
  "api/src/util/csv.ts",
  "api/src/util/format.ts",
  "api/src/util/validate.ts",
  "api/tests/invoiceService.test.ts",
  "config/app.toml",
  "config/settings.json",
  "db/migrations/001_create_invoices.sql",
  "db/migrations/002_add_status_index.sql",
  "db/queries/invoices.sql",
  "docker-compose.yml",
  "docs/api.md",
  "docs/architecture.md",
  "web/index.html",
  "web/src/App.tsx",
  "web/src/components/Greeting.tsx",
  "web/src/components/InvoiceList.tsx",
  "web/src/components/InvoiceRow.tsx",
  "web/src/hooks/useInvoices.ts",
  "web/src/lib/format.ts",
  "web/src/lib/validate.ts",
  "web/src/main.tsx",
  "web/src/styles/base.css",
  "web/src/styles/invoice.module.css",
  "web/src/styles/theme.scss",
  "web/tests/format.test.ts",
  "worker/format.py",
  "worker/main.py",
  "worker/names.py",
  "worker/queue_client.py",
  "worker/requirements.txt",
  "worker/tasks.py",
  "worker/tests/test_tasks.py",
  "worker/validate.py",
];

const EXPECTED_SKIPPED: SkippedPath[] = [
  { path: ".env.example", reason: "secret" },
  { path: "web/src/vendor/tracker.min.js", reason: "minified" },
];

const tasks = JSON.parse(await readFile(join(FIXTURES, "mixed-app.tasks.json"), "utf8")) as LabeledTask[];
const loaded = await loadChunks(ROOT);

/** Resolves a label (`path::symbol`, `path::symbol@start-end` or a bare whole-file `path`) to the chunks it matches. */
function resolve(label: string, chunks: readonly CodeChunk[]): CodeChunk[] {
  const split = label.indexOf("::");
  if (split < 0) {
    const inFile = chunks.filter((chunk) => chunk.file === label);
    return inFile.length === 1 && inFile[0]?.kind === "file" ? inFile : [];
  }
  const path = label.slice(0, split);
  const symbol = label.slice(split + 2);
  const ranged = /^(.*)@(\d+)-(\d+)$/.exec(symbol);
  const [name, start, end] = ranged
    ? [ranged[1], Number(ranged[2]), Number(ranged[3])]
    : [symbol, undefined, undefined];
  return chunks.filter(
    (chunk) =>
      chunk.file === path &&
      chunk.name === name &&
      (start === undefined || (chunk.startLine === start && chunk.endLine === end)),
  );
}

const labelsOf = (task: LabeledTask) => [...task.required, ...task.useful, ...task.irrelevant];

describe("mixed-app scan", () => {
  test("eligible files are exactly the intended list", async () => {
    const scan = await scanRepository(ROOT);
    expect(scan.files).toEqual(EXPECTED_ELIGIBLE);
    expect(scan.warnings).toEqual([]);
  });

  test("skipped files are exactly the intended list, with reasons", async () => {
    expect((await scanRepository(ROOT)).skipped).toEqual(EXPECTED_SKIPPED);
  });

  test("the broken file is eligible and every eligible file has a language", async () => {
    const scan = await scanRepository(ROOT);
    expect(scan.files).toContain(BROKEN_FILE);
    for (const file of scan.files) expect(classifyFile(file, "").language).toBeDefined();
  });

  test("the fixture holds no lockfile and no file the redactor would change", async () => {
    for (const file of EXPECTED_ELIGIBLE) {
      expect(file).not.toMatch(/lock/i);
      expect(await readFile(join(ROOT, file), "utf8")).not.toContain("[REDACTED]");
    }
    expect(loaded.chunks.some((chunk) => chunk.content.includes("[REDACTED]"))).toBe(false);
  });
});

describe("mixed-app labels", () => {
  test("there are at least two tasks with all three label lists populated", () => {
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const task of tasks) {
      expect(task.task.length).toBeGreaterThan(10);
      expect(task.required.length).toBeGreaterThan(0);
      expect(task.useful.length).toBeGreaterThan(0);
      expect(task.irrelevant.length).toBeGreaterThan(0);
    }
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  });

  test("every label resolves to exactly one chunk", () => {
    const unresolved: string[] = [];
    for (const task of tasks) {
      for (const label of labelsOf(task)) {
        const found = resolve(label, loaded.chunks).length;
        if (found !== 1) unresolved.push(`${task.id}: ${label} matched ${found} chunks`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("labels never overlap or repeat within a task", () => {
    for (const task of tasks) {
      const ids = labelsOf(task).map((label) => resolve(label, loaded.chunks)[0]?.id);
      expect(new Set(labelsOf(task)).size).toBe(labelsOf(task).length);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("the same-name decoys exist as separate chunks", () => {
    for (const name of ["format", "validate"]) {
      const files = loaded.chunks.filter((chunk) => chunk.name === name && chunk.kind === "function");
      expect(files.map((chunk) => chunk.file)).toHaveLength(3);
    }
    const queries = loaded.chunks.filter((chunk) => chunk.file === "db/queries/invoices.sql");
    expect(queries.filter((chunk) => chunk.name === "select from invoices")).toHaveLength(2);
  });
});

describe("mixed-app analysis", () => {
  test("nested symbols are chunks linked to their containers", () => {
    const byName = (file: string, name: string) => resolve(`${file}::${name}`, loaded.chunks)[0];
    const ledger = byName("api/src/models/invoice.ts", "Billing.Ledger");
    expect(ledger?.containerName).toBe("Billing");
    expect(byName("api/src/models/invoice.ts", "Billing.Ledger.add")?.containerName).toBe("Billing.Ledger");
    const stats = byName("worker/queue_client.py", "ReminderQueue.Stats");
    expect(stats?.containerName).toBe("ReminderQueue");
    expect(byName("worker/queue_client.py", "ReminderQueue.Stats.record")?.containerName).toBe("ReminderQueue.Stats");
    expect(byName("worker/main.py", "__main__")?.kind).toBe("section");
  });

  test("the broken file warns about syntax errors and the fallback still yields chunks", async () => {
    expect(loaded.warnings.some((w) => w.startsWith(`${BROKEN_FILE}: syntax errors; extracted 1 declarations`))).toBe(
      true,
    );
    const chunks = loaded.chunks.filter((chunk) => chunk.file === BROKEN_FILE);
    expect(chunks.map((chunk) => chunk.name)).toContain("summarize");
    // The truncated function is not a declaration, but its lines are covered by a text window.
    const source = await readFile(join(ROOT, BROKEN_FILE), "utf8");
    const truncated = source.split("\n").findIndex((line) => line.startsWith("export function renderReport")) + 1;
    expect(chunks.some((chunk) => chunk.startLine <= truncated && chunk.endLine >= truncated && !chunk.name)).toBe(
      true,
    );
  });

  test("chunk content is exactly the claimed source lines, in every file (CRLF and Unicode included)", async () => {
    for (const file of EXPECTED_ELIGIBLE) {
      const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
      for (const chunk of loaded.chunks.filter((c) => c.file === file)) {
        expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
      }
    }
  });

  test("the CRLF file keeps every carriage return and chunks like its LF twin", async () => {
    const source = await readFile(join(ROOT, CRLF_FILE), "utf8");
    expect(source).toContain("\r\n");
    expect(source.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const crlf = loaded.chunks.filter((chunk) => chunk.file === CRLF_FILE);
    expect(crlf.map((chunk) => chunk.name)).toEqual(["escapeCell", "toCsv"]);
    for (const chunk of crlf) {
      // Content spans whole lines, each ending in the original CRLF except that the final terminator is dropped.
      expect(chunk.content.split("\n").every((line, i, all) => line.endsWith("\r") || i === all.length - 1)).toBe(true);
      expect(chunk.content.endsWith("\r")).toBe(true);
    }
    const lf = await analyzeFile(
      { path: CRLF_FILE, source: source.replace(/\r\n/g, "\n") },
      "typescript",
      charsPerTokenEstimator,
    );
    expect(lf.chunks.map((chunk) => chunk.id)).toEqual(crlf.map((chunk) => chunk.id));
  });

  test("Unicode identifiers and strings survive intact", () => {
    const names = loaded.chunks.map((chunk) => `${chunk.file}::${chunk.name}`);
    expect(names).toContain("api/src/i18n/messages.ts::合計");
    expect(names).toContain("api/src/i18n/messages.ts::naïveSlug");
    expect(names).toContain("web/src/components/Greeting.tsx::Größe");
    expect(names).toContain("worker/names.py::grüßen");
    expect(names).toContain("worker/names.py::Kundin.fällig_in");
    const messages = resolve("api/src/i18n/messages.ts::messages", loaded.chunks)[0];
    expect(messages?.content).toContain("支払い済み");
    expect(messages?.content).toContain("Просрочено");
    expect(resolve("worker/names.py::GREETINGS", loaded.chunks)[0]?.content).toContain("Здравствуйте");
  });

  test("analysis is deterministic", async () => {
    const again = await loadChunks(ROOT);
    expect(again.chunks.map((chunk) => chunk.id)).toEqual(loaded.chunks.map((chunk) => chunk.id));
    expect(again.warnings).toEqual(loaded.warnings);
    expect(new Set(loaded.chunks.map((chunk) => chunk.id)).size).toBe(loaded.chunks.length);
  });
});
