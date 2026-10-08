// Adaptive retrieval weights (#78): proposes weights from a repository's own history and feedback, evaluates them
// against the baseline on the fixture's HELD-OUT labeled tasks, and promotes them only with --promote and only if the
// held-out candidate recall strictly improves.
//
// Usage: bun scripts/adapt-weights.ts <repo> --fixture <name> [--promote]
//
// Label isolation. The evaluation calls `selectCandidates` (retrieval only) through scripts/recall-lib.ts and never
// `runScope`, so a held-out task's text and labels are never written to history, feedback, decisions or memory, and
// can never influence a later proposal. The proposal comes only from the repository's existing external feedback.
// That history may already hold a held-out task (someone ran it through `scope`); those runs and their feedback are
// left out of the proposal, and the report counts them. Only the stored task text identifies a run, so a reworded
// held-out task cannot be recognized; keep held-out tasks out of the repository's real use.
// `<repo>` is the repository whose cache is read and whose chunks are scored; it should hold the fixture's source.

import { resolve } from "node:path";
import { openRepositoryCache } from "../src/cache/location.ts";
import { readFeedback } from "../src/cache/feedback.ts";
import { MAX_TASK_CHARS, readHistory, redactCredentials } from "../src/cache/history.ts";
import {
  SIGNAL_NAMES,
  evaluateProposal,
  judgePromotion,
  promoteWeights,
  proposeWeights,
  type Evaluation,
  type Multipliers,
  type PromotionOutcome,
} from "../src/cache/weights.ts";
import { loadChunks } from "../src/scope.ts";
import { loadLabeledTasks } from "../tests/helpers/labels.ts";
import { measureRecall, pct } from "./recall-lib.ts";

export interface AdaptationReport {
  multipliers: Multipliers;
  identity: boolean;
  samples: { runs: number; useful: number; reference: number };
  /** Runs of a held-out task found in history and left out of the proposal, with their feedback. */
  excludedHeldoutRuns: number;
  evaluation: Evaluation;
  outcome: PromotionOutcome | { promoted: false; reason: string };
  /** Cache warnings (unreadable key, skipped documents). */
  warnings: string[];
}

export async function runAdaptation(options: {
  repo: string;
  fixture: string;
  promote?: boolean;
  integrityEnv?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<AdaptationReport> {
  const { chunks } = await loadChunks(options.repo);
  const opened = await openRepositoryCache(options.repo, {
    readOnly: !options.promote,
    integrityEnv: options.integrityEnv,
  });
  const warnings = [...opened.warnings];
  const history = opened.cache ? await readHistory(opened.cache) : { records: [], warnings: [] };
  const feedback = opened.cache ? await readFeedback(opened.cache) : { records: [], warnings: [] };
  warnings.push(...history.warnings, ...feedback.warnings);
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const heldout = new Set(
    (await loadLabeledTasks(options.fixture))
      .filter((task) => task.split === "heldout")
      .map((task) => normalize(redactCredentials(task.task).slice(0, MAX_TASK_CHARS))),
  );
  const excluded = new Set(
    history.records.filter((record) => heldout.has(normalize(record.task.text))).map((record) => record.runId),
  );
  const proposal = proposeWeights({
    history: history.records.filter((record) => !excluded.has(record.runId)),
    feedback: feedback.records.filter((record) => !excluded.has(record.runId)),
    chunks,
  });
  const evaluation = await evaluateProposal(proposal.multipliers, async (config) => {
    const rows = await measureRecall(options.fixture, chunks, { config, split: "heldout" });
    return {
      tasks: rows.length,
      found: rows.reduce((sum, row) => sum + row.found.length, 0),
      total: rows.reduce((sum, row) => sum + row.found.length + row.missed.length, 0),
    };
  });
  let outcome: AdaptationReport["outcome"];
  if (!options.promote) {
    const verdict = judgePromotion(proposal.multipliers, evaluation);
    outcome = {
      promoted: false,
      reason: verdict.promote ? "the gate would allow it; rerun with --promote" : `the gate refuses: ${verdict.reason}`,
    };
  } else if (!opened.cache) outcome = { promoted: false, reason: "no cache to write to" };
  else outcome = await promoteWeights(opened.cache, proposal.multipliers, evaluation, { now: options.now });
  return {
    multipliers: proposal.multipliers,
    identity: proposal.identity,
    samples: proposal.samples,
    excludedHeldoutRuns: excluded.size,
    evaluation,
    outcome,
    warnings,
  };
}

export function formatReport(report: AdaptationReport): string {
  const { evaluation: e } = report;
  const lines = [
    report.identity
      ? "proposal: identity (no confirmed feedback to learn from, or no signal difference)"
      : `proposal learned from ${report.samples.runs} runs (${report.samples.useful} useful, ${report.samples.reference} reference chunks)`,
    ...(report.excludedHeldoutRuns > 0
      ? [`left out ${report.excludedHeldoutRuns} history runs of held-out tasks (and their feedback)`]
      : []),
    `multipliers: ${SIGNAL_NAMES.map((name) => `${name} ${report.multipliers[name]}`).join(", ")}`,
    `held-out tasks: ${e.tasks}`,
    `baseline recall: ${e.baseline.found}/${e.baseline.total} ${pct(e.baseline.found, e.baseline.total)}`,
    `proposal recall: ${e.proposal.found}/${e.proposal.total} ${pct(e.proposal.found, e.proposal.total)}`,
    report.outcome.promoted ? `promoted: ${report.outcome.record.version}` : `not promoted: ${report.outcome.reason}`,
  ];
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const promote = args.includes("--promote");
  const flag = args.indexOf("--fixture");
  const fixture = flag >= 0 ? args[flag + 1] : undefined;
  const repo = args.find((arg, index) => !arg.startsWith("--") && index !== flag + 1);
  if (!repo || !fixture) {
    console.error("Usage: bun scripts/adapt-weights.ts <repo> --fixture <name> [--promote]");
    process.exit(2);
  }
  process.stdout.write(formatReport(await runAdaptation({ repo: resolve(repo), fixture, promote })));
}
