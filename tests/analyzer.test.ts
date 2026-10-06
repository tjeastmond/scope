import { expect, test } from "bun:test";
import { analyzeFile, analyzerFor } from "../src/analyzers/index.ts";

const SOURCE = "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";

test("the registry resolves known languages and returns undefined for others", () => {
  expect(analyzerFor("typescript")?.languages).toContain("typescript");
  expect(analyzerFor("go")).toBeUndefined();
});

test("analyzeFile returns chunks and a warnings array", async () => {
  const result = await analyzeFile({ path: "src/a.ts", source: SOURCE }, "typescript");
  expect(result.chunks.map((c) => c.name)).toEqual(["a", "b"]);
  expect(result.warnings).toEqual([]);
});

test("analyzeFile falls back to text windows, with a warning, for a language without an analyzer", async () => {
  const result = await analyzeFile({ path: "x.go", source: "package x\n" }, "go");
  expect(result.chunks.map((c) => c.kind)).toEqual(["file"]);
  expect(result.warnings).toEqual([expect.stringMatching(/^x\.go: no analyzer for language "go"/)]);
});

test("CRLF files give the same ranges and ids as LF, and content keeps the original text", async () => {
  const lf = await analyzeFile({ path: "src/a.ts", source: SOURCE }, "typescript");
  const crlf = await analyzeFile({ path: "src/a.ts", source: SOURCE.replaceAll("\n", "\r\n") }, "typescript");
  expect(crlf.chunks.map((c) => [c.id, c.startLine, c.endLine])).toEqual(
    lf.chunks.map((c) => [c.id, c.startLine, c.endLine]),
  );
  // Lines are split on "\n" only, so every "\r" stays, including the one ending the last line.
  expect(crlf.chunks[0]!.content).toBe("export function a() {\r\n  return 1;\r\n}\r");
});
