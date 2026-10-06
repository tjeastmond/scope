import { describe, expect, test } from "bun:test";
import { splitIdentifier, stem, tokenizeText } from "../src/retrieval/terms.ts";

describe("splitIdentifier", () => {
  const cases: [string, string[]][] = [
    ["listByStatus", ["list", "by", "status"]],
    ["InvoiceService", ["invoice", "service"]],
    ["HTTPServer", ["http", "server"]],
    ["parseXMLFile", ["parse", "xml", "file"]],
    ["list_by_status", ["list", "by", "status"]],
    ["due-date", ["due", "date"]],
    ["Invoice.listByStatus", ["invoice", "list", "by", "status"]],
    ["api/src/util/csv.ts", ["api", "src", "util", "csv", "ts"]],
    ["sha256Hash", ["sha", "256", "hash"]],
    ["  spaced   out ", ["spaced", "out"]],
    ["Größe_café", ["größe", "café"]],
    ["", []],
    ["___", []],
  ];
  test.each(cases)("%p", (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });
});

describe("stem", () => {
  const cases: [string, string][] = [
    ["retries", "retry"],
    ["retry", "retry"],
    ["invoices", "invoice"],
    ["boxes", "box"],
    ["matches", "match"],
    ["statuses", "status"],
    ["class", "class"],
    ["retrying", "retry"],
    ["parsed", "pars"],
    ["bus", "bus"],
    ["sing", "sing"],
    ["used", "used"],
    ["red", "red"],
  ];
  test.each(cases)("%p -> %p", (input, expected) => {
    expect(stem(input)).toBe(expected);
  });
});

describe("tokenizeText", () => {
  test("splits, stems, drops short and numeric tokens, and keeps duplicates in order", () => {
    expect(tokenizeText("retryJobs(a, 256) retry jobs")).toEqual(["retry", "job", "retry", "job"]);
  });

  test("handles empty input", () => {
    expect(tokenizeText("")).toEqual([]);
  });
});
