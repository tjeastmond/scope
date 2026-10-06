import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFormat } from "../src/output/index.ts";
import { runScope } from "../src/scope.ts";
import { fakeProvider } from "./helpers/fake-provider.ts";

// Selection has no size cap: every relevant chunk comes back, however much text that is.
const TASK = "rebuild the ledger reconciliation";
const FUNCTIONS = 12;
const body = (lines: number) => Array.from({ length: lines }, (_unused, i) => `  total += ledger${i};`).join("\n");
const fn = (name: string, lines: number) =>
  `export function ${name}(): number {\n  let total = 0;\n${body(lines)}\n  return total;\n}\n`;

let repo: string;
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "scope-unbounded-"));
  for (let i = 0; i < FUNCTIONS; i++) await writeFile(join(repo, `ledger${i}.ts`), fn(`reconcileLedger${i}`, 250));
  await writeFile(join(repo, "huge.ts"), fn("reconcileLedgerHuge", 6000));
});
afterAll(() => rm(repo, { recursive: true, force: true }));

const judged = () => fakeProvider({ fallback: 0.9 });

test("relevant chunks totalling far more than the old default budget are all returned", async () => {
  const { result } = await runScope({ task: TASK, repo, provider: judged() });
  const text = renderFormat("text", result);
  // The old default was 8000 estimated tokens (about 32,000 characters); this output is several times that.
  expect(text.length).toBeGreaterThan(32_000 * 3);
  const names = result.chunks.map((c) => c.chunk.name);
  for (let i = 0; i < FUNCTIONS; i++) expect(names).toContain(`reconcileLedger${i}`);
  expect(result.skipped).toEqual([]);
  expect(result.warnings.filter((w) => /left out|budget/i.test(w))).toEqual([]);
});

test("a single huge chunk is included whole", async () => {
  const { result } = await runScope({ task: TASK, repo, provider: judged() });
  const huge = result.chunks.find((c) => c.chunk.name === "reconcileLedgerHuge");
  expect(huge).toBeDefined();
  expect(huge!.chunk.content.length).toBeGreaterThan(100_000);
  expect(result.regions.find((r) => r.file === "huge.ts")?.content).toBe(huge!.chunk.content);
});

test("repeated --no-jev runs are byte-identical in every format", async () => {
  for (const format of ["text", "markdown", "json"] as const) {
    const first = await runScope({ task: TASK, repo, noJev: true });
    const second = await runScope({ task: TASK, repo, noJev: true });
    expect(renderFormat(format, second.result)).toBe(renderFormat(format, first.result));
  }
});
