import { describe, expect, test } from "bun:test";
import { splitIdentifier, stem, tokenizeText } from "../src/retrieval/terms.ts";

describe("splitIdentifier", () => {
  test("splits each letter/digit run the same way wherever it sits in a longer text", () => {
    expect(splitIdentifier("parseHTTPResponse_v2.json/fooBar İstanbul cafe\u0301s")).toEqual([
      "parse",
      "http",
      "response",
      "v",
      "2",
      "json",
      "foo",
      "bar",
      "i",
      "stanbul",
      "cafe",
      "s",
    ]);
  });

  test("lowercases capital sigma with its whole-text context, across separators and combining marks", () => {
    expect(splitIdentifier("ΑΣ'Α")).toEqual(["ασ", "α"]);
    expect(splitIdentifier("Α\u0301Σ")).toEqual(["α", "ς"]);
    expect(splitIdentifier("ΟΔΟΣ_ΑΣ")).toEqual(["οδος", "ας"]);
  });

  test("splits a run with more words than a call accepts arguments", () => {
    const words = splitIdentifier("a1".repeat(400_000));
    expect(words.length).toBe(800_000);
    expect(words.slice(0, 4)).toEqual(["a", "1", "a", "1"]);
  });

  test("returns a fresh array, so a caller's changes never leak into later calls", () => {
    const words = splitIdentifier("fooBar");
    words.push("leaked");
    expect(splitIdentifier("fooBar")).toEqual(["foo", "bar"]);
  });

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
    ["status", "status"],
    ["analysis", "analysis"],
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
