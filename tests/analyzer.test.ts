import { expect, test } from "bun:test";
import { analyzeFile, analyzerFor } from "../src/analyzers/index.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";

const SOURCE = "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";

test("the registry resolves known languages and returns undefined for others", () => {
  expect(analyzerFor("typescript")?.languages).toContain("typescript");
  expect(analyzerFor("go")).toBeUndefined();
});

test("analyzeFile returns chunks and a warnings array", async () => {
  const result = await analyzeFile({ path: "src/a.ts", source: SOURCE }, "typescript", charsPerTokenEstimator);
  expect(result.chunks.map((c) => c.name)).toEqual(["a", "b"]);
  expect(result.warnings).toEqual([]);
});

test("analyzeFile fails clearly for a language without an analyzer", async () => {
  await expect(analyzeFile({ path: "x.go", source: "" }, "go", charsPerTokenEstimator)).rejects.toThrow(/go/);
});

test("CRLF files give the same ranges and ids as LF, and content keeps the original text", async () => {
  const lf = await analyzeFile({ path: "src/a.ts", source: SOURCE }, "typescript", charsPerTokenEstimator);
  const crlf = await analyzeFile(
    { path: "src/a.ts", source: SOURCE.replaceAll("\n", "\r\n") },
    "typescript",
    charsPerTokenEstimator,
  );
  expect(crlf.chunks.map((c) => [c.id, c.startLine, c.endLine])).toEqual(
    lf.chunks.map((c) => [c.id, c.startLine, c.endLine]),
  );
  // Lines are split on "\n" only, so every "\r" stays, including the one ending the last line.
  expect(crlf.chunks[0]!.content).toBe("export function a() {\r\n  return 1;\r\n}\r");
});
