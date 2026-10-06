import { describe, expect, test } from "bun:test";
import { extractTaskTerms, splitIdentifier } from "../src/retrieval/terms.ts";

describe("splitIdentifier edge cases", () => {
  const cases: [string, string[]][] = [
    ["HTTPServer", ["http", "server"]],
    ["parseXMLFile", ["parse", "xml", "file"]],
    ["getHTTPResponseCode", ["get", "http", "response", "code"]],
    ["foo_barBaz-qux.v2", ["foo", "bar", "baz", "qux", "v", "2"]],
    ["utf8Decode", ["utf", "8", "decode"]],
    ["ÉcoleÉlève", ["école", "élève"]],
    ["支払い_status", ["支払い", "status"]],
  ];
  test.each(cases)("%p", (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });
});

describe("extractTaskTerms exact terms", () => {
  const cases: [string, string, string[]][] = [
    ["backtick spans", "Rename `parseStripeWebhook` and `due date` here", ["parseStripeWebhook", "due date"]],
    ["double quotes", 'Show the "overdue invoices" banner', ["overdue invoices"]],
    ["single quotes", "Show the 'overdue' banner", ["overdue"]],
    ["apostrophes are not quotes", "each invoice's due date and the customer's name", []],
    ["apostrophes before a closing quote", "invoice's due date for the customers' name", []],
    ["call syntax", "Fix foo.bar() when it throws", ["foo.bar", "foo", "bar"]],
    ["plain call", "Call retry() twice.", ["retry"]],
    [
      "paths",
      "Read config/app.toml and app.toml, then api/src/util/csv.ts.",
      ["config/app.toml", "app.toml", "api/src/util/csv.ts"],
    ],
    [
      "camel and snake case",
      "The dueDate field and InvoiceDto plus send_reminder.",
      ["dueDate", "InvoiceDto", "send_reminder"],
    ],
    ["member access", "Use Billing.Invoice here", ["Billing.Invoice", "Billing", "Invoice"]],
    ["strips punctuation", "(see dueDate), then `x.y`.", ["dueDate", "x.y"]],
    ["dedupes in order", "dueDate then InvoiceDto then dueDate", ["dueDate", "InvoiceDto"]],
    ["ordinary prose has none", "Add a localized status column to the export.", []],
    ["relative paths keep their prefix", "Use ./src/cli.ts and ../src/types.ts", ["./src/cli.ts", "../src/types.ts"]],
    ["version-like and abbreviations are not code", "Use v1.2 and e.g. fast", []],
  ];
  test.each(cases)("%s", (_name, task, expected) => {
    expect(extractTaskTerms(task).exact).toEqual(expected);
  });
});

describe("extractTaskTerms words", () => {
  const cases: [string, string, string[]][] = [
    ["stop words and short words are dropped", "Add the status of an invoice to it", ["add", "status", "invoice"]],
    ["stemming", "retries retrying and Invoices", ["retry", "invoice"]],
    ["digits dropped", "Use 2 retries after 30 seconds", ["use", "retry", "second"]],
    ["identifier split", "Rename `parseStripeWebhook`", ["rename", "parse", "stripe", "webhook"]],
    ["prose identifiers split in place", "The dueDate column", ["due", "date", "column"]],
    ["quoted words count", 'Add "late fee" support', ["add", "late", "fee", "support"]],
    ["unicode", "Kundin grüßen", ["kundin", "grüßen"]],
  ];
  test.each(cases)("%s", (_name, task, expected) => {
    expect(extractTaskTerms(task).words).toEqual(expected);
  });
});

describe("extractTaskTerms variants", () => {
  test("joins adjacent content words, pairs then triples", () => {
    const { variants } = extractTaskTerms("show due date column");
    expect(variants).toEqual(
      expect.arrayContaining(["showdue", "showduedate", "duedate", "datecolumn", "duedatecolumn"]),
    );
    expect(variants.indexOf("showdue")).toBeLessThan(variants.indexOf("showduedate"));
  });

  test("a run ending at a stop word still joins", () => {
    expect(extractTaskTerms("due date of invoices").variants).toContain("duedate");
  });

  test("stop words and punctuation break adjacency", () => {
    const { variants } = extractTaskTerms("status of invoices, then export");
    expect(variants).not.toContain("statusinvoices");
    expect(variants).not.toContain("invoicesthen");
    expect(variants).not.toContain("invoicesexport");
  });

  test("includes stemmed joins that meet singular names", () => {
    expect(extractTaskTerms("retry attempts").variants).toEqual(["retryattempts", "retryattempt"]);
  });

  test("multi-word exact terms are joined lowercase", () => {
    expect(extractTaskTerms("Change `parseStripeWebhook` and send_reminder").variants).toEqual(
      expect.arrayContaining(["parsestripewebhook", "sendreminder"]),
    );
    expect(extractTaskTerms("Read `config/app.toml`").variants).not.toContain("configapptoml");
  });

  test("single-word exact terms add no variant", () => {
    expect(extractTaskTerms("`retry`").variants).toEqual([]);
  });
});

describe("extractTaskTerms general", () => {
  test.each(["", "   ", "\n\t "])("empty or whitespace-only task %p yields empty arrays", (task) => {
    expect(extractTaskTerms(task)).toEqual({ exact: [], words: [], variants: [] });
  });

  test("is deterministic", () => {
    const task = "Make `parseStripeWebhook` retry; read config/app.toml and dueDate.";
    expect(extractTaskTerms(task)).toEqual(extractTaskTerms(task));
  });

  test("words keep first-appearance order across code spans and prose", () => {
    expect(extractTaskTerms("Fix `dueDate` column").words).toEqual(["fix", "due", "date", "column"]);
  });

  test("backtick contents are not also scanned as prose", () => {
    const terms = extractTaskTerms("Use `foo.bar` here");
    expect(terms.exact).toEqual(["foo.bar"]);
    expect(terms.words).toEqual(["use", "foo", "bar"]);
  });
});
