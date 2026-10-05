import { expect, test } from "bun:test";
import { format } from "../src/lib/format";

test("formats cents as euros", () => {
  expect(format(123456, "EUR")).toContain("1.234,56");
});

test("formats zero", () => {
  expect(format(0, "EUR")).toContain("0,00");
});
