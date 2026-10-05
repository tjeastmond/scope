// Loads every supported grammar from the compiled build and parses a tiny sample.
// Usage (after `bun run build`): node scripts/check-grammars.mjs
import process from "node:process";
import { GRAMMARS, parserFor } from "../dist/analyzers/parser.js";

const samples = {
  typescript: "const a: number = 1;",
  tsx: "const a = <div />;",
  javascript: "const a = 1;",
  python: "a = 1\n",
  html: "<p>hi</p>",
  css: "a { color: red; }",
  json: '{"a": 1}',
  yaml: "a: 1\n",
  toml: "a = 1\n",
};

let failed = false;
for (const grammar of GRAMMARS) {
  const tree = (await parserFor(grammar)).parse(samples[grammar]);
  const ok = tree !== null && !tree.rootNode.hasError;
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${grammar}\n`);
}
process.stdout.write(`node ${process.version}: ${failed ? "FAILED" : "all grammars loaded"}\n`);
process.exit(failed ? 1 : 0);
