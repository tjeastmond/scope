// Markdown report of an evaluation run. Pure: the same results always render the same text, in a fixed order.

import type {
  Aggregate,
  EvalOutput,
  FixtureBaseline,
  Mode,
  OverheadAggregate,
  SplitKey,
  TaskEntry,
  TaskModeResult,
} from "./runner.ts";
import type { Spread } from "./metrics.ts";

const pct = (value: number | null) => (value === null ? "n/a" : `${(100 * value).toFixed(1)}%`);
const signedPct = (value: number | null) =>
  value === null ? "n/a" : `${value >= 0 ? "+" : "-"}${Math.abs(100 * value).toFixed(1)} pts`;
const int = (value: number | null) => (value === null ? "n/a" : Math.round(value).toLocaleString("en-US"));
const signedInt = (value: number | null) =>
  value === null ? "n/a" : `${value >= 0 ? "+" : "-"}${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
const ratio = (r: { count: number; total: number; value: number | null }) => `${pct(r.value)} (${r.count}/${r.total})`;
const range = (s: Spread | null, format: (n: number) => string) =>
  s === null ? "n/a" : `${format(s.min)} / ${format(s.mean)} / ${format(s.max)}`;

const MODE_TITLES: Record<Mode, string> = {
  lexical: "Lexical baseline (BM25, fixed top-k)",
  "no-jev": "Scope without Jev (`--no-jev`)",
  jev: "Scope with Jev",
};

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export interface RenderOptions {
  /** Omit volatile provenance (clock times, current commit, output paths) so equal inputs render equal bytes. */
  deterministic?: boolean;
}

function provenance({ run }: EvalOutput, { deterministic = false }: RenderOptions): string {
  const rows: [string, string][] = [
    ["Scope version", run.scopeVersion],
    ["Retrieval config version", run.retrievalConfigVersion],
    ["Jev question version", run.jevQuestionVersion],
    ["`@typesafe-ai/sdk` version", run.sdkVersion],
    ["Model", run.replay ? `${run.replay.model} (recorded)` : run.model],
    ...(deterministic
      ? []
      : [
          ["Git commit", `${run.commit}${run.dirty ? " (working tree had uncommitted changes)" : ""}`] as [
            string,
            string,
          ],
        ]),
    ["Labels checksum", run.labelsChecksum],
    ["Modes", run.modes.join(", ")],
    ["Split", run.split],
    ["Fixtures", run.fixtures.join(", ")],
    ["Repeat", String(run.repeat)],
    ["Lexical top-k", String(run.lexicalTopK)],
    ["Coverage threshold", String(run.coverageThreshold)],
    ...(deterministic
      ? []
      : [["Started", run.startedAt] as [string, string], ["Finished", run.finishedAt] as [string, string]]),
  ];
  if (run.record && !deterministic) rows.push(["Recorded to", run.record]);
  if (run.replay)
    rows.push([
      "Replayed from",
      `${run.replay.file} (recorded ${run.replay.recordedAt} at ${run.replay.commit} with SDK ${run.replay.sdkVersion})`,
    ]);
  const lock = Object.entries(run.fixtureLock).map(([name, hash]) => [name, `\`${hash}\``]);
  return [
    "## Provenance",
    "",
    table(
      ["Field", "Value"],
      rows.map(([k, v]) => [k, v]),
    ),
    "",
    "Fixture revisions (`tasks/fixtures.lock.json`):",
    "",
    table(["Fixture", "sha256"], lock),
  ].join("\n");
}

function baselines(baseline: Record<string, FixtureBaseline>): string {
  const rows = Object.entries(baseline).map(([name, b]) => [
    name,
    int(b.eligibleFiles),
    int(b.eligibleChars),
    Object.entries(b.exclusions)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", ") || "none",
  ]);
  return [
    "## Full-repository baseline",
    "",
    "Eligible characters are the decoded text of every file Scope's own scan keeps (ignored, secret, binary, lockfile, " +
      "minified, oversized and build paths excluded). Sizes are characters, not tokens. A directory skipped as a whole " +
      "counts once.",
    "",
    table(["Fixture", "Eligible files", "Eligible characters", "Exclusions (paths per reason)"], rows),
  ].join("\n");
}

function taskTable(tasks: readonly TaskEntry[], mode: Mode): string {
  const rows = tasks.flatMap((t) => {
    const m: TaskModeResult | undefined = t.modes[mode];
    if (!m) return [];
    return [
      [
        `${t.fixture}/${t.id}`,
        t.split,
        ratio(m.recall),
        ratio(m.precision),
        pct(m.irrelevantRate),
        pct(m.unlabeledShare),
        int(m.selectedChars),
        pct(m.sizeReduction),
      ],
    ];
  });
  return table(
    [
      "Task",
      "Split",
      "Required recall",
      "Precision",
      "Irrelevant rate",
      "Unlabeled share",
      "Selected chars",
      "Size reduction",
    ],
    rows,
  );
}

function aggregateTable(by: Partial<Record<SplitKey, Aggregate>>): string {
  const rows = (["tuning", "heldout", "all"] as const).flatMap((key) => {
    const a = by[key];
    if (!a) return [];
    return [
      [
        key === "all" ? "overall" : key,
        String(a.tasks),
        pct(a.recall.macro),
        `${pct(a.recall.micro)} (${a.recall.covered}/${a.recall.required})`,
        `${pct(a.precision.macro)} (${a.precision.definedTasks} tasks)`,
        pct(a.irrelevantRate.macro),
        pct(a.unlabeledShare.macro),
        int(a.selectedChars.total),
        int(a.selectedChars.mean),
        pct(a.sizeReduction.macro),
      ],
    ];
  });
  return table(
    [
      "Split",
      "Tasks",
      "Recall (mean of tasks)",
      "Recall (pooled)",
      "Precision (mean of tasks)",
      "Irrelevant rate",
      "Unlabeled share",
      "Selected chars (total)",
      "Selected chars (mean)",
      "Size reduction (mean)",
    ],
    rows,
  );
}

function modeSections({ results }: EvalOutput): string {
  return results.tasks.length === 0
    ? ""
    : (Object.keys(results.aggregates) as Mode[])
        .map((mode) =>
          [
            `## ${MODE_TITLES[mode]}`,
            "",
            "### Per task",
            "",
            taskTable(results.tasks, mode),
            "",
            "### Aggregates",
            "",
            aggregateTable(results.aggregates[mode] ?? {}),
          ].join("\n"),
        )
        .join("\n\n");
}

function impactSection({ results }: EvalOutput): string {
  if (!results.impact) return "";
  const { tasks, aggregates } = results.impact;
  const per = tasks.map((row) => [
    `${row.fixture}/${row.id}`,
    row.split,
    signedPct(row.recall),
    signedPct(row.precision),
    signedInt(row.selectedChars),
  ]);
  const agg = (["tuning", "heldout", "all"] as const).flatMap((key) => {
    const a = aggregates[key];
    return a
      ? [
          [
            key === "all" ? "overall" : key,
            String(a.tasks),
            signedPct(a.recall),
            signedPct(a.precision),
            signedInt(a.selectedChars),
            `${a.recallImproved} better / ${a.recallSame} same / ${a.recallWorse} worse`,
          ],
        ]
      : [];
  });
  return [
    "## Jev impact (paired, Jev minus no-Jev)",
    "",
    "Each difference is the `jev` result minus the `no-jev` result on the same task and the same repository snapshot. " +
      "Precision differences are n/a when either side selected nothing.",
    "",
    table(["Task", "Split", "Recall", "Precision", "Selected chars"], per),
    "",
    table(["Split", "Tasks", "Mean recall", "Mean precision", "Mean selected chars", "Recall by task"], agg),
  ].join("\n");
}

function overheadSection({ results }: EvalOutput): string {
  if (!results.overhead) return "";
  const { tasks, aggregates } = results.overhead;
  const per = tasks.map((row) => [
    `${row.fixture}/${row.id}`,
    row.split,
    int(row.latencyMs),
    int(row.inputTokens),
    int(row.outputTokens),
    int(row.combinedTokens),
  ]);
  const agg = (["tuning", "heldout", "all"] as const).flatMap((key) => {
    const a: OverheadAggregate | undefined = aggregates[key];
    return a
      ? [
          [
            key === "all" ? "overall" : key,
            String(a.tasks),
            int(a.latencyMs.total),
            int(a.latencyMs.mean),
            int(a.inputTokens),
            int(a.outputTokens),
            int(a.combinedTokens),
          ],
        ]
      : [];
  });
  return [
    "## Jev overhead",
    "",
    "Latency is the wall clock of the whole Jev decision for the task, in milliseconds. Tokens are as reported by Jev, " +
      "summed over its requests, and are reported separately from the size of the selected context. Cost is omitted: " +
      "current Jev pricing has not been verified, so no price-based cost is computed.",
    "",
    table(["Task", "Split", "Latency (ms)", "Input tokens", "Output tokens", "Combined tokens"], per),
    "",
    table(
      ["Split", "Tasks", "Total latency (ms)", "Mean latency (ms)", "Input tokens", "Output tokens", "Combined tokens"],
      agg,
    ),
  ].join("\n");
}

function variabilitySection({ results, run }: EvalOutput): string {
  if (!results.variability) return "";
  const rows = results.variability.map((v) => [
    `${v.fixture}/${v.id}`,
    String(v.repeats),
    range(v.recall, (n) => pct(n)),
    range(v.precision, (n) => pct(n)),
    range(v.selectedChars, int),
    range(v.latencyMs, int),
    range(v.inputTokens, int),
    range(v.outputTokens, int),
  ]);
  return [
    `## Variability (${run.repeat} repeats)`,
    "",
    "Each cell is min / mean / max over the repeats of one live Jev task. The per-task tables above show the first run.",
    "",
    table(
      ["Task", "Runs", "Recall", "Precision", "Selected chars", "Latency (ms)", "Input tokens", "Output tokens"],
      rows,
    ),
  ].join("\n");
}

function findingsSection({ results }: EvalOutput): string {
  if (!results.findings) return "";
  const titles = {
    "recall-regression": "Recall regressions (jev recall below no-jev)",
    "identical-selection": "No difference (jev selected what no-jev selected)",
    "no-gain": "No improvement (different selection, no gain in recall or precision)",
  } as const;
  const parts = (Object.keys(titles) as (keyof typeof titles)[]).map((kind) => {
    const items = results.findings?.filter((f) => f.kind === kind) ?? [];
    return [
      `### ${titles[kind]}`,
      "",
      ...(items.length === 0 ? ["None."] : items.map((f) => `- \`${f.fixture}/${f.id}\` (${f.split}): ${f.detail}`)),
    ].join("\n");
  });
  return ["## Regressions and no-improvement cases", "", ...parts].join("\n\n");
}

const NOTES = [
  "## Notes",
  "",
  "- Sizes are characters of source. Output-format overhead (headers, fences, JSON structure) is excluded, so size reduction compares selected source with eligible repository source only.",
  "- A labeled unit is covered when the selection contains at least the coverage threshold of its lines; precision counts a selected chunk when it cover-matches a required or useful unit in either direction. See `docs/evaluation.md`.",
  "- Precision is n/a (not 0 or 1) for a task that selected nothing. Means skip n/a values.",
  "- A selected line inside both a required or useful unit and an irrelevant one counts as wanted, not irrelevant.",
  "- Tuning and heldout tasks are always aggregated separately; the overall row is shown only when both ran.",
].join("\n");

export function renderReport(output: EvalOutput, options: RenderOptions = {}): string {
  const sections = [
    "# Scope evaluation report",
    provenance(output, options),
    baselines(output.results.baseline),
    modeSections(output),
    impactSection(output),
    overheadSection(output),
    variabilitySection(output),
    findingsSection(output),
    NOTES,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}
