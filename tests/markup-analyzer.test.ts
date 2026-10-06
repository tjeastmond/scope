import { expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { extractHtmlChunks, markupAnalyzer } from "../src/analyzers/markup.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Shop</title>
  <style>
    body { margin: 0; }
  </style>
  <script src="app.js"></script>
  <script type="module">
    import "./a.js";
  </script>
</head>
<body>
  <header id="top">
    <nav aria-label="Primary"><a href="/">Home</a></nav>
  </header>
  <div class="wrap">
    <main>
      <section class="hero"><h1>Big   sale</h1></section>
      <article>
        <h2>News</h2>
        <script>var inner = 1;</script>
      </article>
    </main>
    <aside><p>side</p></aside>
  </div>
  <template id="row"><tr><td>x</td></tr></template>
  <form action="/s"><input></form>
  <footer>
  </footer>
</body>
</html>
`;

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

const analyze = (source: string, path = "web/index.html") => extractHtmlChunks(path, source, heuristicEstimator);

test("golden inventory: landmarks, inline script and style with exact ranges", async () => {
  const { chunks, warnings } = await analyze(PAGE);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "style:style@5-7",
    "section:script@9-11",
    "section:header#top@14-16",
    'section:main "Big sale"@18-24',
    "section:aside@25-25",
    "template:template#row@27-27",
    "section:form@28-28",
    "section:footer@29-30",
  ]);
});

test("content is the exact source lines; elements nested in a landmark stay inside it", async () => {
  const { chunks } = await analyze(PAGE);
  const lines = PAGE.split("\n");
  for (const chunk of chunks) {
    expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
    expect(chunk.language).toBe("html");
    expect(chunk.references).toEqual([]);
  }
  expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  const main = chunks.find((c) => c.name?.startsWith("main"));
  expect(main?.content).toContain("<script>var inner = 1;</script>");
  expect(chunks.some((c) => c.name?.startsWith("nav") || c.name?.startsWith("article"))).toBe(false);
  expect(chunks.find((c) => c.kind === "style")?.content).toBe("  <style>\n    body { margin: 0; }\n  </style>");
});

test("names come from id, aria-label, class, first heading, else the tag", async () => {
  const { chunks } = await analyze(
    `<nav id="a" aria-label="X" class="c"></nav>
<nav aria-label="  Main
  menu "></nav>
<section class="  hero big"></section>
<article><div><h3>A <em>bold</em>
 title</h3></div></article>
<aside></aside>
<style id="theme">a { b: c }</style>
`,
  );
  expect(chunks.map((c) => c.name)).toEqual([
    "nav#a",
    'nav "Main menu"',
    "section.hero",
    'article "A bold title"',
    "aside",
    "style#theme",
  ]);
});

test("a landmark inside a plain div is found; one inside a landmark is not a separate chunk", async () => {
  const { chunks } = await analyze(`<div><div>
<section>
  <section id="inner"></section>
</section>
</div></div>
`);
  expect(inventory(chunks)).toEqual(["section:section@2-4"]);
});

test("empty script and style blocks are not chunks", async () => {
  const { chunks } = await analyze(`<script src="a.js"></script>\n<script>  \n</script>\n<style></style>\n`);
  expect(chunks).toEqual([]);
});

test("same-line duplicates collapse to one chunk", async () => {
  const { chunks } = await analyze("<nav></nav><nav></nav>\n");
  expect(inventory(chunks)).toEqual(["section:nav@1-1"]);
});

test("tag names are case-insensitive and unicode survives", async () => {
  const { chunks } = await analyze(
    `<HEADER ID="Top"><H1>Größe 日本語</H1></HEADER>\n<MAIN><H1>Größe 日本語</H1></MAIN>\n`,
  );
  expect(chunks.map((c) => c.name)).toEqual(["header#Top", 'main "Größe 日本語"']);
});

test("CRLF source gives the same inventory and IDs as LF", async () => {
  const lf = await analyze(PAGE);
  const crlf = await analyze(PAGE.replaceAll("\n", "\r\n"));
  expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
  expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
  expect(crlf.chunks.find((c) => c.name === "aside")?.content).toBe("    <aside><p>side</p></aside>\r");
});

test("an unclosed <html> or <body> is valid HTML and yields its landmarks without a warning", async () => {
  const { chunks, warnings } = await analyze(
    `<html><body>\n<header>H</header>\n<script>\nlet a = 1;\n</script>\n<main>M</main>\n`,
  );
  expect(inventory(chunks)).toEqual(["section:header@2-2", "section:script@3-5", "section:main@6-6"]);
  expect(warnings).toEqual([]);
});

test("landmarks around an unclosed landmark are kept (error nodes are looked through) with a warning", async () => {
  const { chunks, warnings } = await analyze(
    `<html><body>\n<header>H</header>\n<section>\n<script>\nlet a = 1;\n</script>\n<main>M</main>\n`,
  );
  expect(inventory(chunks)).toEqual(["section:header@2-2", "section:script@4-6", "section:main@7-7"]);
  expect(warnings).toEqual(["web/index.html: syntax errors; extracted 3 chunks from the parseable regions"]);
});

test("an unclosed landmark is dropped with a warning and the rest is kept", async () => {
  const { chunks, warnings } = await analyze(`<main>\n<p>one\n</main>\n<section>\n<h2>Two</h2>\n<footer>f</footer>\n`);
  expect(chunks.map((c) => c.name)).toContain("main");
  expect(chunks.find((c) => c.name === "main")).toMatchObject({ startLine: 1, endLine: 3 });
  expect(warnings).toHaveLength(1);
});

test("an unclosed script keeps what parsed and warns instead of throwing", async () => {
  const { chunks, warnings } = await analyze(`<nav>n</nav>\n<script>\nlet a = 1;\n`);
  expect(chunks.map((c) => c.name)).toContain("nav");
  expect(warnings).toHaveLength(1);
});

test("empty and whitespace-only files give no chunks and no warning", async () => {
  expect(await analyze("")).toEqual({ chunks: [], warnings: [] });
  expect(await analyze("  \n\n")).toEqual({ chunks: [], warnings: [] });
});

test("plain text with no landmarks gives no chunks", async () => {
  expect((await analyze("<p>hello</p>\n<div>x</div>\n")).chunks).toEqual([]);
});

test("registered for html and dispatched through the registry", async () => {
  expect(markupAnalyzer.languages).toEqual(["html"]);
  const result = await analyzeFile({ path: "a.html", source: "<main>x</main>\n" }, "html", heuristicEstimator);
  expect(inventory(result.chunks)).toEqual(["section:main@1-1"]);
});
