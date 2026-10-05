import { describe, expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { extractStyleChunks, styleAnalyzer } from "../src/analyzers/style.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const CSS = `@charset "utf-8";
@import url("a.css");
:root { --brand: #fff; }
/* a { */
a,
b   > c { content: "}"; }
@media (min-width: 1px) {
  .x { color: red; }
  @supports (display: grid) {
    .y { display: grid }
  }
}
@font-face { font-family: "F"; }
@keyframes spin { from { a: b } to { a: c } }
@layer base, theme;
h1 { font: "ü" }
`;

const SCSS = `@use "sass:math";
@import url(a;b{.css);
$gap: 8px;
$map: (
  a: 1,
  b: 2
);
--top: 1;
// line comment with { brace
%placeholder { color: red; }
.card {
  &:hover { color: blue; }
  .title#{$suffix} { width: math.div(10px, 2); }
  background: url(data:image/png;base64,AAA{);
  content: "}";
  // } stray
  /* } */
}
@mixin bp($n) {
  @media (min-width: $n) { @content; }
}
@include bp(10px) { .z { a: b } }
.a-#{"}"} { x: y }
@include foo;
`;

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);
const css = (source: string) => extractStyleChunks("web/site.css", source, charsPerTokenEstimator);
const scss = (source: string) => extractStyleChunks("web/site.scss", source, charsPerTokenEstimator);

describe("css", () => {
  test("golden inventory: rules and at-rules as units, body-less statements as config", async () => {
    const { chunks, warnings } = await css(CSS);
    expect(warnings).toEqual([]);
    expect(inventory(chunks)).toEqual([
      'config:@charset "utf-8"@1-1',
      'config:@import url("a.css")@2-2',
      "style::root@3-3",
      "style:a, b > c@5-6",
      "style:@media (min-width: 1px)@7-12",
      "style:@font-face@13-13",
      "style:@keyframes spin@14-14",
      "config:@layer base, theme@15-15",
      "style:h1@16-16",
    ]);
    expect(chunks.every((c) => c.language === "css")).toBe(true);
  });

  test("nested at-rules stay inside the @media chunk; content is exact lines", async () => {
    const { chunks } = await css(CSS);
    const lines = CSS.split("\n");
    for (const chunk of chunks) expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunks.find((c) => c.name?.startsWith("@media"))?.content).toContain("@supports (display: grid)");
  });

  test("a prelude with multi-byte characters is named correctly", async () => {
    const { chunks } = await css(`.ünï[data-x="日本"],\n.b { color: red }\n`);
    expect(inventory(chunks)).toEqual(['style:.ünï[data-x="日本"], .b@1-2']);
  });

  test("CRLF source gives the same inventory and IDs as LF", async () => {
    const lf = await css(CSS);
    const crlf = await css(CSS.replaceAll("\n", "\r\n"));
    expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
    expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
    expect(crlf.chunks.at(-1)?.content).toBe('h1 { font: "ü" }\r');
  });

  test("an unclosed brace keeps the rule up to the end of the file and warns", async () => {
    const { chunks, warnings } = await css("a { x: y }\n.b { c: d;\n.c { e: f }\n");
    expect(inventory(chunks)).toEqual(["style:a@1-1", "style:.b@2-3"]);
    expect(warnings).toEqual(["web/site.css: syntax errors; extracted 2 chunks from the parseable regions"]);
  });

  test("same-line duplicates collapse to one chunk", async () => {
    expect(inventory((await css("a { x: y } a { x: y }\n")).chunks)).toEqual(["style:a@1-1"]);
  });

  test("empty and comment-only files give no chunks", async () => {
    expect(await css("")).toEqual({ chunks: [], warnings: [] });
    expect(await css("/* nothing */\n")).toEqual({ chunks: [], warnings: [] });
  });
});

describe("scss", () => {
  test("golden inventory: nesting stays in the parent, braces in strings/comments/url/interpolation are ignored", async () => {
    const { chunks, warnings } = await scss(SCSS);
    expect(warnings).toEqual([]);
    expect(inventory(chunks)).toEqual([
      'config:@use "sass:math"@1-1',
      "config:@import url(a;b{.css)@2-2",
      "config:$gap@3-3",
      "config:$map@4-7",
      "config:--top@8-8",
      "style:%placeholder@10-10",
      "style:.card@11-18",
      "style:@mixin bp($n)@19-21",
      "style:@include bp(10px)@22-22",
      'style:.a-#{"}"}@23-23',
      "config:@include foo@24-24",
    ]);
    expect(chunks.every((c) => c.language === "scss")).toBe(true);
  });

  test("content is exact lines and comments between statements belong to no chunk", async () => {
    const { chunks } = await scss(SCSS);
    const lines = SCSS.split("\n");
    for (const chunk of chunks) expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunks.some((c) => c.content.includes("line comment"))).toBe(false);
    expect(chunks.find((c) => c.name === ".card")?.content).toContain("&:hover");
  });

  test("a rule that follows a block comment on the same line starts after the comment", async () => {
    const { chunks } = await scss("/* head */ a { x: y }\n");
    expect(inventory(chunks)).toEqual(["style:a@1-1"]);
  });

  test("CRLF source gives the same inventory and IDs as LF", async () => {
    const lf = await scss(SCSS);
    const crlf = await scss(SCSS.replaceAll("\n", "\r\n"));
    expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
    expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
  });

  test("an unclosed brace keeps the statement to the end of the file and warns", async () => {
    const { chunks, warnings } = await scss("a { x: y }\n.b {\n  .c { e: f }\n\n");
    expect(inventory(chunks)).toEqual(["style:a@1-1", "style:.b@2-3"]);
    expect(warnings).toEqual(["web/site.scss: syntax errors; extracted 2 chunks from the parseable regions"]);
  });

  test("a stray closing brace is skipped with a warning", async () => {
    const { chunks, warnings } = await scss("a { x: y }\n}\nb { x: y }\n");
    expect(inventory(chunks)).toEqual(["style:a@1-1", "style:b@3-3"]);
    expect(warnings).toHaveLength(1);
  });

  test("unterminated comments, strings and interpolation warn without throwing", async () => {
    expect((await scss("a { x: y }\n/* open { \n")).warnings).toHaveLength(1);
    expect((await scss('a { content: "oops }\n}\nb { x: y }\n')).warnings).toHaveLength(1);
    const open = await scss("a { x: y }\n.b-#{ { c: d\n");
    expect(open.chunks.map((c) => c.name)).toEqual(["a", ".b-#{ { c: d"]);
    expect(open.warnings).toHaveLength(1);
  });

  test("a trailing statement without a semicolon is kept", async () => {
    const { chunks, warnings } = await scss("$a: 1;\n$b: 2\n\n");
    expect(inventory(chunks)).toEqual(["config:$a@1-1", "config:$b@2-2"]);
    expect(warnings).toEqual([]);
  });

  test("empty and comment-only files give no chunks", async () => {
    expect(await scss("")).toEqual({ chunks: [], warnings: [] });
    expect(await scss("// nothing\n/* x */\n")).toEqual({ chunks: [], warnings: [] });
  });
});

test("registered for css and scss and dispatched through the registry", async () => {
  expect(styleAnalyzer.languages).toEqual(["css", "scss"]);
  const source = "a { x: y }\n";
  expect(inventory((await analyzeFile({ path: "a.css", source }, "css", charsPerTokenEstimator)).chunks)).toEqual([
    "style:a@1-1",
  ]);
  const result = await analyzeFile({ path: "a.scss", source }, "scss", charsPerTokenEstimator);
  expect(result.chunks.map((c) => c.language)).toEqual(["scss"]);
});
