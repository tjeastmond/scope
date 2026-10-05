import { expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { extractMarkdownChunks, markdownAnalyzer } from "../src/analyzers/markdown.ts";
import { charsPerTokenEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.name}@${c.startLine}-${c.endLine}`);
const analyze = (source: string, path = "docs/guide.md") => extractMarkdownChunks(path, source, charsPerTokenEstimator);
const names = (source: string) => inventory(analyze(source).chunks);

const GUIDE = `Intro text.

# Guide

Welcome.

## Install

\`\`\`sh
# not a heading
## nor this
\`\`\`

### From source

Build it.

## Usage

Run it.

# Appendix

Done.
`;

test("golden inventory: nested sections, parents cover children, heading paths", () => {
  const { chunks, warnings } = analyze(GUIDE);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "preamble@1-2",
    "Guide@3-21",
    "Guide > Install@7-17",
    "Guide > Install > From source@14-17",
    "Guide > Usage@18-21",
    "Appendix@22-24",
  ]);
  const lines = GUIDE.split("\n");
  for (const chunk of chunks) {
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunk.kind).toBe("section");
    expect(chunk.language).toBe("markdown");
    expect(chunk.references).toEqual([]);
  }
  expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
});

test("# lines inside ``` and ~~~ fences are not headings; fence length and kind rules apply", () => {
  const source = [
    "# A",
    "````md",
    "```",
    "# still code",
    "```",
    "# still code",
    "````",
    "~~~",
    "# code",
    "```",
    "# code",
    "~~~",
    "## B",
    "```js",
    "# unclosed runs to EOF",
    "## C",
  ].join("\n");
  expect(names(source)).toEqual(["A@1-16", "A > B@13-16"]);
});

test("a backtick fence with a backtick in its info string is not a fence", () => {
  expect(names("``` `x`\n# H\n")).toEqual(["preamble@1-1", "H@2-2"]);
});

test("setext headings, multi-line paragraphs, and thematic breaks", () => {
  const source = [
    "Title",
    "=====",
    "",
    "Para one",
    "continues",
    "---",
    "",
    "text",
    "",
    "---",
    "",
    "***",
    "",
    "- item",
    "---",
    "",
  ].join("\n");
  expect(names(source)).toEqual(["Title@1-15", "Title > Para one continues@4-15"]);
});

test("a setext underline needs a paragraph above it; `---` after a blank line is a break", () => {
  expect(names("intro\n\n---\n\nmore\n")).toEqual(["preamble@1-5"]);
  expect(names("> quote\n---\n")).toEqual(["preamble@1-2"]);
  expect(names("    code\n===\n")).toEqual(["preamble@1-2"]);
});

test("a file with no headings is one preamble; blank files have no chunks", () => {
  expect(names("just text\nmore\n")).toEqual(["preamble@1-2"]);
  expect(names("")).toEqual([]);
  expect(names("\n  \n\n")).toEqual([]);
});

test("front matter is part of the preamble and its `---` lines are not headings", () => {
  const source = "---\ntitle: Doc\n# comment in yaml\n---\n# Real\ntext\n";
  expect(names(source)).toEqual(["preamble@1-4", "Real@5-6"]);
  expect(names("---\ntitle: x\n---\n")).toEqual(["preamble@1-3"]);
  // Unclosed front matter is just a thematic break.
  expect(names("---\n# H\n")).toEqual(["preamble@1-1", "H@2-2"]);
});

test("trailing hashes, inline formatting, indentation limits, and empty headings", () => {
  const source = [
    "# **Bold** `code` [link](u) ##",
    "   ## Indented three   ",
    "    # four spaces is code",
    "#hashtag",
    "### C# ",
    "#### foo \\#",
    "##",
    "####### seven",
  ].join("\n");
  expect(names(source)).toEqual([
    "**Bold** `code` [link](u)@1-8",
    "**Bold** `code` [link](u) > Indented three@2-6",
    "**Bold** `code` [link](u) > Indented three > C#@5-6",
    "**Bold** `code` [link](u) > Indented three > C# > foo \\#@6-6",
    "**Bold** `code` [link](u) > (empty heading)@7-8",
  ]);
});

test("skipped levels attach to the nearest shallower heading", () => {
  expect(names("# A\n### C\n## B\n#### D\n# E\n")).toEqual([
    "A@1-4",
    "A > C@2-2",
    "A > B@3-4",
    "A > B > D@4-4",
    "E@5-5",
  ]);
});

test("a deeper heading before any shallower one does not become its ancestor", () => {
  expect(names("### Deep\n# Top\n## Mid\n")).toEqual(["Deep@1-1", "Top@2-3", "Top > Mid@3-3"]);
});

test("duplicate heading paths are separate chunks told apart by range and id", () => {
  const { chunks } = analyze("# A\n## Same\n## Same\n");
  expect(inventory(chunks)).toEqual(["A@1-3", "A > Same@2-2", "A > Same@3-3"]);
  expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
});

test("CRLF gives LF ranges and ids, keeps \\r in content, and recognizes every heading form", () => {
  const lf = "pre\n\n# One\n\nSetext\n---\n\n```\n# code\n```\n## Two ##\nend";
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = analyze(lf).chunks;
  const b = analyze(crlf).chunks;
  expect(inventory(b)).toEqual(["preamble@1-2", "One@3-12", "One > Setext@5-10", "One > Two@11-12"]);
  expect(inventory(b)).toEqual(inventory(a));
  expect(b.map((c) => c.id)).toEqual(a.map((c) => c.id));
  expect(b[1]!.content).toBe(crlf.split("\n").slice(2, 12).join("\n"));
  expect(b[1]!.content).toContain("\r\n");
});

test("no trailing newline and a heading on the last line", () => {
  expect(names("# A\ntext")).toEqual(["A@1-2"]);
  expect(names("text\n# A")).toEqual(["preamble@1-1", "A@2-2"]);
});

test("unicode headings", () => {
  expect(names("# Größe 日本語\n")).toEqual(["Größe 日本語@1-1"]);
});

test("registered for markdown and callable through analyzeFile", async () => {
  expect(markdownAnalyzer.languages).toEqual(["markdown"]);
  const result = await analyzeFile({ path: "README.md", source: "# Hi\n" }, "markdown", charsPerTokenEstimator);
  expect(inventory(result.chunks)).toEqual(["Hi@1-1"]);
  expect(result.chunks[0]!.estimatedTokens).toBe(charsPerTokenEstimator.count("# Hi"));
});

test("a thematic break is not the first line of a setext paragraph", () => {
  expect(names("***\n---\ntext\n")).toEqual(["preamble@1-3"]);
});

test("a list item or blockquote continuation followed by --- is not a setext heading", () => {
  const source = "# Log\n\n## 1.0\n\n- Fix parser so it\n  handles tabs\n---\n\nnotes\n\n## 0.9\n";
  expect(names(source)).toEqual(["Log@1-11", "Log > 1.0@3-10", "Log > 0.9@11-11"]);
});

test("a leading --- followed by a blank line is a thematic break, not front matter", () => {
  expect(names("---\n\n# Title\n\nbody\n\n---\n\n## Next\n")).toEqual([
    "preamble@1-2",
    "Title@3-9",
    "Title > Next@9-9",
  ]);
});

test("headings inside HTML comments are not headings", () => {
  expect(names("# A\n\n<!--\n# hidden\n-->\n\n## B\n")).toEqual(["A@1-7", "A > B@7-7"]);
  expect(names("# A\n<!-- # one line -->\n## B\n")).toEqual(["A@1-3", "A > B@3-3"]);
});

test("an unterminated HTML comment opener inside a fence does not hide later headings", () => {
  expect(names("# A\n```html\n<!-- start\n```\n# B\n")).toEqual(["A@1-5", "B@5-5"]);
});
