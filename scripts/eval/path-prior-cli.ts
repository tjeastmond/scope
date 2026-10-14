// EXPERIMENTAL (issue #166): live comparison of Scope with and without the Jev path prior over the labeled tasks.
// Not part of `bun run validate` or package.json: it needs TYPESAFE_API_KEY and sends the task, the shortlisted source
// and (for the prior) file and directory names to TypeSafe/Jev. It never prints the key.
//
//   bun scripts/eval/path-prior-cli.ts [--split tuning|heldout|all] [--fixture <name> ...]

import { parseArgs } from "node:util";
import { loadChunks, runScope, type ScopeRun } from "../../src/scope.ts";
import { assertFixtureLock, assertFrozen, EvalError, labelsChecksum } from "./freeze.ts";
import { FIXTURES, listTaskFixtures, loadLabeledTasks, unitOf } from "./labels.ts";
import { mean, requiredRecall } from "./metrics.ts";
import { join } from "node:path";

const USAGE = `Usage: bun scripts/eval/path-prior-cli.ts [--split tuning|heldout|all] [--fixture <name> ...]

Runs every labeled task twice with Jev (baseline, then with the experimental path prior) and prints a markdown table.
Needs TYPESAFE_API_KEY. Heldout and all splits require frozen labels (bun run eval:freeze).`;

interface Side {
  candidateRecall: number | null;
  selectionRecall: number | null;
  latencyMs: number;
  tokens: number;
}

function measure(run: ScopeRun, required: ReturnType<typeof unitOf>[]): Side {
  const jev = run.result.jev;
  const prior = run.pathPrior;
  return {
    candidateRecall: requiredRecall(required, run.candidates).value,
    selectionRecall: requiredRecall(
      required,
      run.result.chunks.map(({ chunk }) => chunk),
    ).value,
    latencyMs: (jev?.latencyMs ?? 0) + (prior?.latencyMs ?? 0),
    tokens:
      (jev ? jev.usage.inputTokens + jev.usage.outputTokens : 0) +
      (prior ? prior.usage.inputTokens + prior.usage.outputTokens : 0),
  };
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
const num = (value: number | null, digits = 0) => (value === null ? "n/a" : value.toFixed(digits));

async function main() {
  const { values } = parseArgs({
    options: {
      split: { type: "string", default: "tuning" },
      fixture: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return console.log(USAGE);
  const split = values.split ?? "tuning";
  if (!["tuning", "heldout", "all"].includes(split)) throw new EvalError(`Unknown --split ${split}.`);
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new EvalError("This comparison needs TYPESAFE_API_KEY.");
  if (split === "tuning") await labelsChecksum();
  else await assertFrozen();
  const known = await listTaskFixtures();
  for (const name of values.fixture ?? [])
    if (!known.includes(name)) throw new EvalError(`Unknown fixture ${name}. Known: ${known.join(", ")}.`);
  const fixtures = values.fixture?.length ? known.filter((name) => values.fixture?.includes(name)) : known;
  await assertFixtureLock(fixtures);

  const rows: { id: string; base: Side; prior: Side; added: number; boosted: number }[] = [];
  for (const fixture of fixtures) {
    const root = join(FIXTURES, fixture);
    const { chunks } = await loadChunks(root);
    for (const task of await loadLabeledTasks(fixture)) {
      if (split !== "all" && task.split !== split) continue;
      const required = task.required.map((label) => unitOf(label, chunks));
      const base = measure(await runScope({ task: task.task, repo: root }), required);
      const withPrior = await runScope({ task: task.task, repo: root, pathPrior: true });
      rows.push({
        id: `${fixture}/${task.id}`,
        base,
        prior: measure(withPrior, required),
        added: withPrior.pathPrior?.contribution.added.length ?? 0,
        boosted: withPrior.pathPrior?.contribution.boosted ?? 0,
      });
      console.error(`done ${fixture}/${task.id}`);
    }
  }

  const lines = [
    "| task | cand recall base | cand recall prior | sel recall base | sel recall prior | latency base (ms) | latency prior (ms) | tokens base | tokens prior | added | boosted |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${pct(r.base.candidateRecall)} | ${pct(r.prior.candidateRecall)} | ${pct(r.base.selectionRecall)} | ` +
        `${pct(r.prior.selectionRecall)} | ${r.base.latencyMs} | ${r.prior.latencyMs} | ${r.base.tokens} | ${r.prior.tokens} | ` +
        `${r.added} | ${r.boosted} |`,
    ),
    `| **mean (${rows.length})** | ${pct(mean(rows.map((r) => r.base.candidateRecall)))} | ${pct(mean(rows.map((r) => r.prior.candidateRecall)))} | ` +
      `${pct(mean(rows.map((r) => r.base.selectionRecall)))} | ${pct(mean(rows.map((r) => r.prior.selectionRecall)))} | ` +
      `${num(mean(rows.map((r) => r.base.latencyMs)))} | ${num(mean(rows.map((r) => r.prior.latencyMs)))} | ` +
      `${num(mean(rows.map((r) => r.base.tokens)))} | ${num(mean(rows.map((r) => r.prior.tokens)))} | ` +
      `${num(mean(rows.map((r) => r.added)), 1)} | ${num(mean(rows.map((r) => r.boosted)), 1)} |`,
  ];
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof EvalError
        ? `error: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    );
    process.exitCode = 1;
  });
}
