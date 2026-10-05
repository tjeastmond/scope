import { expect, test } from "bun:test";
import { GRAMMARS, parserFor, type Grammar } from "../src/analyzers/parser.ts";

const SAMPLES: Record<Grammar, string> = {
  typescript: "export function add(a: number, b: number): number { return a + b; }\ninterface I { x: string }\n",
  tsx: 'export const App = () => <div className="a">hi</div>;\n',
  javascript: "const add = (a, b) => a + b;\nconst el = <p>{add(1, 2)}</p>;\n",
  python: "def add(a, b):\n    return a + b\n\nclass C:\n    pass\n",
  html: '<!doctype html><html><body><p class="a">hi</p></body></html>\n',
  css: ".a { color: red; }\n@media (min-width: 1px) { .b { margin: 0; } }\n",
  json: '{ "a": [1, 2, { "b": null }] }\n',
  yaml: "a:\n  - b: 1\n  - c: two\n",
  toml: '[package]\nname = "scope"\nversion = "1.0.0"\n',
};

for (const grammar of GRAMMARS) {
  test(`loads the ${grammar} grammar and parses a sample without errors`, async () => {
    const parser = await parserFor(grammar);
    const tree = parser.parse(SAMPLES[grammar]);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.childCount).toBeGreaterThan(0);
  });
}

test("parserFor caches one parser per grammar", async () => {
  expect(await parserFor("json")).toBe(await parserFor("json"));
});

test("parserFor fails clearly for an unsupported grammar", async () => {
  await expect(parserFor("sql" as Grammar)).rejects.toThrow("Unsupported grammar: sql");
});
