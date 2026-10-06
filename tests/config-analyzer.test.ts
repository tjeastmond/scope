import { expect, test } from "bun:test";
import { analyzeFile } from "../src/analyzers/index.ts";
import { configAnalyzer, extractConfigChunks } from "../src/analyzers/config.ts";
import { heuristicEstimator } from "../src/context/tokens.ts";
import type { CodeChunk } from "../src/types.ts";

const PACKAGE_JSON = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "test": "bun test"
  },
  "dependencies": {
    "left-pad": "^1.3.0"
  },
  "files": ["dist"],
  "private": true,
  "": 0,
  "we\\"ird\\u0041": null
}
`;

const COMPOSE = `# services
version: "3"
x-base: &base
  restart: always
  environment:
    LOG: debug
services:
  web:
    <<: *base
    image: nginx
    command: |
      run
      forever
  db:
    image: postgres
'quoted key': 1
"double": 2
? complex
: value
empty:
`;

const MULTI = `apiVersion: v1
kind: Service
---
apiVersion: apps/v1
kind: Deployment
spec:
  replicas: 2
---
# nothing here
---
- just
- a list
`;

const CARGO = `# manifest
name = "demo"
version = "0.1.0"
metadata.team = "core"

[package]
edition = "2021"

# the binaries
[[bin]]
name = "a"

[[bin]]
name = "b"

[dependencies.serde]
version = "1"

["quoted.key"]
x = 1

[ a . b ]
y = 2
`;

const inventory = (chunks: CodeChunk[]) => chunks.map((c) => `${c.kind}:${c.name}@${c.startLine}-${c.endLine}`);

const analyze = (path: string, source: string) => extractConfigChunks(path, source, heuristicEstimator);

test("golden inventory for package.json: top-level keys only, scripts and dependencies stay whole", async () => {
  const { chunks, warnings } = await analyze("package.json", PACKAGE_JSON);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:name@2-2",
    "config:version@3-3",
    "config:scripts@4-7",
    "config:dependencies@8-10",
    "config:files@11-11",
    "config:private@12-12",
    'config:""@13-13',
    'config:we"irdA@14-14',
  ]);
  expect(chunks[2]?.content).toBe('  "scripts": {\n    "build": "tsc",\n    "test": "bun test"\n  },');
  expect(chunks.every((c) => c.language === "json" && c.file === "package.json" && c.references.length === 0)).toBe(
    true,
  );
});

test("golden inventory for nested YAML with anchors, aliases, block scalars and odd keys", async () => {
  const { chunks, warnings } = await analyze("docker-compose.yml", COMPOSE);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:version@2-2",
    "config:x-base@3-6",
    "config:services@7-15",
    "config:quoted key@16-16",
    "config:double@17-17",
    "config:complex@18-19",
    "config:empty@20-20",
  ]);
  expect(chunks[1]?.content).toBe("x-base: &base\n  restart: always\n  environment:\n    LOG: debug");
  expect(chunks.every((c) => c.language === "yaml")).toBe(true);
});

test("a block scalar at the end of an entry does not pull in the next line", async () => {
  const { chunks } = await analyze("a.yaml", "a: |\n  text\n  more\nb: 2\n");
  expect(inventory(chunks)).toEqual(["config:a@1-3", "config:b@4-4"]);
});

test("multi-document YAML prefixes names with doc[index]; non-mapping documents become one file chunk", async () => {
  const { chunks, warnings } = await analyze("k8s.yaml", MULTI);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:doc[0].apiVersion@1-1",
    "config:doc[0].kind@2-2",
    "config:doc[1].apiVersion@4-4",
    "config:doc[1].kind@5-5",
    "config:doc[1].spec@6-7",
    "file:doc[3]@11-12",
  ]);
  expect(chunks.at(-1)?.content).toBe("- just\n- a list");
});

test("a single YAML document has plain names, and a flow mapping works like a block one", async () => {
  expect(inventory((await analyze("a.yaml", "---\nx: 1\n...\n")).chunks)).toEqual(["config:x@2-2"]);
  expect(inventory((await analyze("a.yaml", "{a: 1,\n b: [2]}\n")).chunks)).toEqual(["config:a@1-1", "config:b@2-2"]);
  expect(inventory((await analyze("a.yaml", "- 1\n- 2\n")).chunks)).toEqual(["file:undefined@1-2"]);
});

test("golden inventory for TOML tables, arrays of tables and root keys", async () => {
  const { chunks, warnings } = await analyze("Cargo.toml", CARGO);
  expect(warnings).toEqual([]);
  expect(inventory(chunks)).toEqual([
    "config:name@2-2",
    "config:version@3-3",
    "config:metadata.team@4-4",
    "config:package@6-7",
    "config:bin[0]@10-11",
    "config:bin[1]@13-14",
    "config:dependencies.serde@16-17",
    'config:"quoted.key"@19-20',
    "config:a.b@22-23",
  ]);
  expect(chunks.find((c) => c.name === "bin[1]")?.content).toBe('[[bin]]\nname = "b"');
  expect(chunks.every((c) => c.language === "toml")).toBe(true);
});

test("top-level JSON arrays and scalars become one file chunk", async () => {
  const array = await analyze("list.json", "[\n  1,\n  2\n]\n");
  expect(inventory(array.chunks)).toEqual(["file:undefined@1-4"]);
  expect(array.chunks[0]?.name).toBeUndefined();
  expect(inventory((await analyze("n.json", "42\n")).chunks)).toEqual(["file:undefined@1-1"]);
});

test("empty and comment-only files give no chunks and no warnings", async () => {
  for (const [path, source] of [
    ["a.json", ""],
    ["a.json", "\n  \n"],
    ["a.yaml", ""],
    ["a.yaml", "# only a comment\n"],
    ["a.toml", ""],
    ["a.toml", "# only a comment\n"],
  ] as const) {
    expect(await analyze(path, source)).toEqual({ chunks: [], warnings: [] });
  }
});

test("JSONC comments and trailing commas warn instead of failing, and the entries survive", async () => {
  const comments = await analyze("tsconfig.json", '{\n  // strict\n  "strict": true, /* x */\n  "target": "es5"\n}\n');
  expect(inventory(comments.chunks)).toEqual(["config:strict@3-3", "config:target@4-4"]);
  expect(comments.warnings).toEqual(["tsconfig.json: contains comments (JSONC); parsed leniently"]);

  const trailing = await analyze("a.json", '{\n  "a": [1,],\n  "b": 2,\n}\n');
  expect(inventory(trailing.chunks)).toEqual(["config:a@2-2", "config:b@3-3"]);
  expect(trailing.warnings).toEqual(["a.json: syntax errors; extracted 2 entries from the parseable regions"]);
});

test("syntax errors keep what parsed, with a warning", async () => {
  const json = await analyze("a.json", '{\n  "a": 1\n  "b": 2,\n  "c": 3\n}\n');
  expect(json.chunks.map((c) => c.name)).toEqual(["a", "b", "c"]);
  expect(json.warnings).toHaveLength(1);

  const unclosed = await analyze("a.json", '{"a": 1');
  expect(unclosed.chunks.map((c) => c.name)).toEqual(["a"]);
  expect(unclosed.warnings).toHaveLength(1);

  const yaml = await analyze("a.yaml", "ok: 1\nbad: [\nnext: 2\n");
  expect(yaml.chunks.length).toBeGreaterThan(0);
  expect(yaml.chunks[0]?.name).toBe("ok");
  expect(yaml.warnings).toEqual([expect.stringMatching(/^a\.yaml: syntax errors; extracted \d+ entries/)]);

  const toml = await analyze("a.toml", "a = 1\n[t]\nb = 2\n[broken\nc =\n");
  expect(toml.chunks.map((c) => c.name)).toEqual(expect.arrayContaining(["a", "t"]));
  expect(toml.warnings).toHaveLength(1);
});

test("a non-empty file with nothing extractable returns only the warning", async () => {
  const { chunks, warnings } = await analyze("a.toml", "[broken\n");
  expect(chunks).toEqual([]);
  expect(warnings).toEqual(["a.toml: syntax errors; extracted 0 entries from the parseable regions"]);
});

test("entries sharing a line range collapse into one file chunk instead of repeating the line", async () => {
  expect(inventory((await analyze("a.json", '{"a": 1, "a": 2, "b": 3}')).chunks)).toEqual(["file:undefined@1-1"]);
  expect(inventory((await analyze("a.json", '{"a":{"x":1},"b":[1,2]}')).chunks)).toEqual(["file:undefined@1-1"]);
  expect(inventory((await analyze("a.json", '{"a": 1,\n"b": 2, "c": 3}')).chunks)).toEqual([
    "config:a@1-1",
    "file:undefined@2-2",
  ]);
});

test("YAML directives are not document bodies", async () => {
  expect(inventory((await analyze("a.yaml", "%YAML 1.2\n---\na: 1\n")).chunks)).toEqual(["config:a@3-3"]);
  expect(inventory((await analyze("a.yaml", "%TAG ! tag:x,2000:\n---\na: 1\n")).chunks)).toEqual(["config:a@3-3"]);
});

test("a trailing empty YAML document does not turn names into doc[N]", async () => {
  expect(inventory((await analyze("a.yaml", "a: 1\n---\n")).chunks)).toEqual(["config:a@1-1"]);
});

test("CRLF and a missing trailing newline give the same inventory and IDs as LF", async () => {
  for (const [path, source] of [
    ["package.json", PACKAGE_JSON],
    ["compose.yml", COMPOSE],
    ["multi.yaml", MULTI],
    ["Cargo.toml", CARGO],
  ] as const) {
    const lf = await analyze(path, source);
    const crlf = await analyze(path, source.replaceAll("\n", "\r\n"));
    expect(inventory(crlf.chunks)).toEqual(inventory(lf.chunks));
    expect(crlf.chunks.map((c) => c.id)).toEqual(lf.chunks.map((c) => c.id));
    const bare = await analyze(path, source.trimEnd());
    expect(inventory(bare.chunks).length).toBe(inventory(lf.chunks).length);
  }
  const crlf = await analyze("a.toml", "[t]\r\nx = 1\r\n");
  expect(crlf.chunks[0]?.content).toBe("[t]\r\nx = 1\r");
});

test("unicode keys and content", async () => {
  const { chunks } = await analyze("a.yaml", "ключ: значение\n日本語:\n  - ü\n");
  expect(inventory(chunks)).toEqual(["config:ключ@1-1", "config:日本語@2-3"]);
});

test("the analyzer is registered for json, yaml and toml and picks the grammar from the path", async () => {
  expect(configAnalyzer.languages).toEqual(["json", "yaml", "toml"]);
  const file = { path: "x/y.yml", source: "a: 1\n" };
  const result = await analyzeFile(file, "yaml", heuristicEstimator);
  expect(inventory(result.chunks)).toEqual(["config:a@1-1"]);
});

test("key quoting: YAML single quotes unescape, an invalid JSON escape keeps the key as written", async () => {
  expect(inventory((await analyze("a.yaml", "'it''s': 1\n")).chunks)).toEqual(["config:it's@1-1"]);
  expect(inventory((await analyze("a.json", '{"x\\q": 1}')).chunks)).toEqual(['config:"x\\q"@1-1']);
});

test("quoted keys differing only in inner whitespace stay distinct", async () => {
  const names = async (path: string, source: string) => (await analyze(path, source)).chunks.map((c) => c.name);
  expect(await names("a.json", '{\n  "a  b": 1,\n  "a b": 2\n}\n')).toEqual(["a  b", "a b"]);
  expect(await names("a.yaml", '"a  b": 1\n"a b": 2\n')).toEqual(["a  b", "a b"]);
  expect(await names("a.toml", '"a  b" = 1\n"a b" = 2\n')).toEqual(['"a  b"', '"a b"']);
});

test("JSON keys with escaped line breaks stay distinct from the same keys with spaces", async () => {
  const chunks = (await analyze("a.json", '{\n"a\\nb": 1,\n"a b": 2,\n"a\\rb": 3\n}')).chunks;
  expect(chunks.map((c) => c.name)).toEqual(['"a\\nb"', "a b", '"a\\rb"']);
});

test("the extension is matched case-insensitively", async () => {
  expect(inventory((await analyze("A.YAML", "a: 1\n")).chunks)).toEqual(["config:a@1-1"]);
});

test("empty and blank files give no chunks and no warning", async () => {
  for (const path of ["a.json", "a.yaml", "a.toml"]) {
    expect(await analyze(path, " \n")).toEqual({ chunks: [], warnings: [] });
  }
});
