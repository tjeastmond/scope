// Dev-only: compares the heuristic estimator with a real tokenizer on the fixture repositories.
// Usage: bun scripts/backtest-estimator.ts
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { heuristicEstimator } from "../src/context/tokens.ts";

const ROOTS = ["fixtures/mixed-app", "fixtures/webhook-service"];
const SKIP = new Set(["node_modules", ".git"]);

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out.sort();
};

interface Row {
  file: string;
  group: string;
  estimate: number;
  real: number;
}

const rows: Row[] = [];
for (const root of ROOTS) {
  for (const file of await walk(root)) {
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    rows.push({
      file: relative(".", file),
      group: extname(file).slice(1) || "(none)",
      estimate: heuristicEstimator.count(text),
      real: encode(text, { allowedSpecial: "all" }).length,
    });
  }
}

const ratio = (e: number, r: number) => (r === 0 ? 0 : e / r).toFixed(3);
const sum = (list: Row[], key: "estimate" | "real") => list.reduce((s, r) => s + r[key], 0);
const line = (name: string, list: Row[]) =>
  `${name.padEnd(9)} ${String(list.length).padStart(5)} ${String(sum(list, "estimate")).padStart(9)} ${String(sum(list, "real")).padStart(6)}  ${ratio(sum(list, "estimate"), sum(list, "real"))}`;

const groups = new Map<string, Row[]>();
for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);

console.log(`estimator: ${heuristicEstimator.id}, tokenizer: gpt-tokenizer o200k_base, files: ${rows.length}`);
console.log("group     files  estimate   real  ratio");
for (const [group, list] of [...groups].sort()) console.log(line(group, list));
console.log(line("overall", rows));
const worst = rows.filter((r) => r.real > 0).sort((a, b) => a.estimate / a.real - b.estimate / b.real)[0];
if (worst) console.log(`lowest file ratio: ${worst.file} ${ratio(worst.estimate, worst.real)}`);
