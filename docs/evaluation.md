# Evaluation

Scope's evaluation set is a collection of fixture repositories under `fixtures/` and labeled tasks under `tasks/`. It
measures whether retrieval and Jev select the chunks a developer needs, and whether a change generalizes beyond the tasks
it was tuned on.

| Fixture           | What it is                                                  | Tasks file                   | Notes                              |
| ----------------- | ----------------------------------------------------------- | ---------------------------- | ---------------------------------- |
| `webhook-service` | Small TypeScript Stripe webhook service                     | `tasks/webhook-service.json` | `fixtures/webhook-service.TASK.md` |
| `mixed-app`       | Multi-language invoicing app (TSX, TS, Python, SQL, config) | `tasks/mixed-app.json`       | `fixtures/mixed-app.TASK.md`       |
| `py-ingest`       | Python feed-ingestion package                               | `tasks/py-ingest.json`       | `fixtures/py-ingest.TASK.md`       |
| `react-dashboard` | React and TypeScript dashboard                              | `tasks/react-dashboard.json` | `fixtures/react-dashboard.TASK.md` |
| `scope-snapshot`  | Frozen copy of Scope's own `src/` at a recorded commit      | `tasks/scope-snapshot.json`  | `fixtures/scope-snapshot.TASK.md`  |

Fixtures are source data only. They are never executed, type-checked, linted or formatted by this repository.
`tests/eval-tasks.test.ts` validates every `tasks/*.json` file (except `fixtures.lock.json`) against its fixture.

## Labeling guide

### File format

`tasks/<fixture>.json` is an array of objects with exactly these fields:

```json
{
  "id": "kebab-case-id",
  "split": "tuning",
  "task": "Natural developer phrasing of the request.",
  "required": ["path::symbol"],
  "useful": ["path::symbol"],
  "irrelevant": ["path::symbol"]
}
```

`id` is unique across all task files, not only within one. `task` reads like something a developer would type, not a
list of identifiers; keep several tasks with little word overlap with the answer, since those are where retrieval is
weakest.

### Label syntax

Paths are relative to `fixtures/<fixture>/`.

- `path::symbol` is the chunk whose `file` is `path` and whose `name` is `symbol`, exactly as the analyzer names it:
  `InvoiceService.create`, `Billing.Ledger`, `.badge` for a CSS rule, `Architecture > Worker > Retries` for a Markdown
  section. Copy names from the analyzer, not from the source: list them with `loadChunks` from `src/scope.ts`.
- `path::symbol@start-end` adds the chunk's 1-based inclusive line range. Use it only when one file has two chunks with
  the same name (`db/queries/invoices.sql` has two `select from invoices`).
- A bare `path` labels a whole-file chunk and is valid only for a file that analyzes to exactly one chunk of kind `file`.

Every label must resolve to exactly one chunk. Not every declaration is a chunk (some constants, for instance, are not
extracted), so check the real chunk list before labeling.

### Required, useful, irrelevant

| List         | Meaning                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `required`   | The change cannot be made correctly without reading or editing this chunk. At least one per task.    |
| `useful`     | Helpful context (callers, types, config, tests). The change could be made without it.                |
| `irrelevant` | Must not be needed. At least three per task, chosen as near-misses and same-name decoys, not filler. |

Chunks not listed are unlabeled and are neither rewarded nor penalized. Prefer a small `required` set: it is the recall
target. Put a chunk in `required` only if removing it would make a competent change impossible. A label may appear in
only one list, and a chunk may be labeled only once per task.

### Stable identities

Labels name a path and a symbol, not a content hash, so they survive edits that do not rename or move the symbol. They do
not survive renames, so never rename symbols in a fixture. If a fixture must change, relabel every affected task in the
same commit and update the lock (below). `fixtures/scope-snapshot/` is never refreshed in place: it records the commit it
was copied from, and a newer snapshot is a deliberate relabeling.

### Split policy

Each task is `tuning` or `heldout`. Retrieval and scoring may be tuned only against `tuning` tasks. `heldout` tasks
measure generalization and are never used to choose weights, thresholds or prompts. Aim for about 60% tuning and 40%
heldout overall, with at least one heldout task on every fixture. A task never changes split after a tuning run has used
it; add a new task instead.

### Lock-hash pinning

`tasks/fixtures.lock.json` maps each fixture name to a sha256 content revision. The hash covers every file under
`fixtures/<fixture>/`, sorted by relative path, using each path, the byte length and the raw bytes (line endings are not
normalized). `hashFixture` in `scripts/eval/fixture-hash.ts` computes it, and `readLock` reads the lock; an evaluation
harness should reuse both and record the revision with every result.

`tests/eval-tasks.test.ts` fails when a fixture changes without the lock. To update after an intended fixture change,
relabel affected tasks, then regenerate the entries:

```sh
bun -e 'import {hashFixture,LOCK_FILE} from "./scripts/eval/fixture-hash.ts"; const names=["mixed-app","py-ingest","react-dashboard","scope-snapshot","webhook-service"]; const lock={}; for (const n of names) lock[n]=await hashFixture(n); await Bun.write(LOCK_FILE, JSON.stringify(lock,null,2)+"\n")'
```

A changed lock entry means earlier results on that fixture are not comparable with later ones.

### Candidate recall

`bun scripts/recall.ts [fixture ...]` reports, per task, how many `required` labels reach the shortlist before Jev sees
it. It bounds what Jev can select.

## Harness

```sh
bun run eval [--mode lexical|no-jev|jev ...] [--split tuning|heldout|all] [--fixture <name> ...]
             [--record <file>] [--replay <file>] [--repeat N] [--out <dir>]
bun run eval:freeze
```

The harness is dev tooling under `scripts/eval/`; nothing in it ships in `src/`. It is not part of `bun run validate`;
its unit tests (`tests/eval-*.test.ts`) run in `bun test` and need no network or key.

- **Modes.** The default is `lexical` and `no-jev` (offline). `lexical` is the baseline: BM25 over every eligible chunk
  with the task's content words, best `LEXICAL_TOP_K = 10` chunks. `no-jev` is `runScope({ noJev: true })`. `jev` uses
  the real provider and fails clearly without `TYPESAFE_API_KEY` (unless `--replay` is given).
- **Output.** `eval-results/<UTC timestamp>.json` and `.md` (the directory is gitignored). The JSON has a `run`
  provenance block and a `results` block; only `results` is reproducible.
- **Record and replay.** `--record <file>` wraps the provider and saves, per task id, the candidate ids and the
  decision (judgments, usage, latency). `--replay <file>` returns the recorded decision and fails loudly if a task is
  missing or its candidate set differs from the recording. A replay's `results` block is byte-identical to the recorded
  run's, so Jev-dependent numbers can be re-derived offline after a scoring change. Committed recordings live in
  `eval-recordings/`.
- **Repeat.** `--repeat N` runs the live Jev mode N times and reports min/mean/max in a variability section. It is valid
  only with `--mode jev`, and not with `--record` or `--replay`. Headline numbers are the first run. The raw files of
  a committed repeated run are `eval-recordings/jev-variability.json` and `.md`.

### The committed report

```sh
bun run eval:report            # regenerate docs/evaluation-report.md
bun run eval:report --check    # compare in memory; exit 1 if the committed file is out of date
```

`docs/evaluation-report.md` is generated, never edited by hand. `eval:report` replays `eval-recordings/jev-baseline.json`
over every task (modes `lexical`, `no-jev` and `jev`, split `all`, repeat 1), so it needs no key and no network. The
render is deterministic: it omits the clock times, the current git commit and output paths, and keeps the Scope, retrieval
and Jev-question versions, labels checksum, fixture hashes, and the recording's model, SDK version, date and commit.
Running it twice leaves the working tree clean, and `--check` never writes. `tests/eval-report.test.ts` also fails when
the committed report is stale.

Regenerate after any retrieval, label or Jev-question change, together with a fresh live recording
(`bun run eval --mode jev --split all --record eval-recordings/jev-baseline.json`, which needs `TYPESAFE_API_KEY`). A
replay refuses a recording whose candidate sets no longer match, which is the signal to re-record. Jev's latency and
token counts in the report come from the recording.

### Split and freeze rules

`--split tuning` needs nothing else. `--split heldout` and `--split all` refuse unless `tasks/labels.freeze.json` exists
and its checksum matches the current `tasks/*.json` (the lock and freeze files excluded). `bun run eval:freeze` writes
that file: the sha256 over the sorted label file names and bytes, the repository revision and the date. Freeze when
labeling is done, before the final comparison, and never run heldout with `jev` while still tuning. Before any run the
fixture lock (`tasks/fixtures.lock.json`) is verified against `fixtures/`, and a mismatch is refused.

## Metrics

All sizes are characters of source. There are no token budgets. A ratio with no denominator is reported as `n/a`, never
0 or 1.

- **Matching policy.** A labeled unit is covered when the selection's line set for the unit's file holds at least
  `COVERAGE_THRESHOLD = 0.8` of the unit's lines, so a merged parent region or several chunks that together span the unit
  count. A selected chunk cover-matches a unit when it shares the unit's file and the overlap is at least 80% of the
  chunk or at least 80% of the unit.
- **Required recall.** Covered `required` units over `required` units. Aggregated as the mean of tasks and pooled
  (covered over required across tasks).
- **Precision.** Selected chunks that cover-match a `required` or `useful` unit over selected chunks. `n/a` when
  nothing was selected.
- **Irrelevant-context rate.** Selected characters inside `irrelevant` units over selected characters. A line also held
  by a required or useful unit counts as wanted. The **unlabeled share** is reported separately: selected characters in
  no labeled unit at all.
- **Size reduction.** `1 - selected characters / eligible repository characters`, where eligible characters are the
  decoded text of every file Scope's own scan keeps. Output-format overhead (headers, fences, JSON structure) is
  excluded.
- **Jev impact.** Per task, the `jev` result minus the `no-jev` result for recall, precision and selected characters,
  on the same snapshot.
- **Jev overhead.** Wall-clock latency and Jev-reported input and output tokens, summed over requests. Cost is
  omitted because current pricing has not been verified.

### Report contents

Provenance (Scope, retrieval config, Jev question and SDK versions, model, revision, labels checksum, fixture
revisions, options); a per-fixture baseline table (eligible files and characters, scan exclusions per skip reason);
per-task and aggregate tables per mode with tuning and heldout kept separate; the paired Jev-impact table; Jev overhead;
variability when repeating; regressions (jev recall below no-jev) and no-improvement cases. Row order is fixed, so the
same results render the same report.
