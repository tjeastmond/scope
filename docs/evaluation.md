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
normalized). `hashFixture` in `tests/helpers/fixture-hash.ts` computes it, and `readLock` reads the lock; an evaluation
harness should reuse both and record the revision with every result.

`tests/eval-tasks.test.ts` fails when a fixture changes without the lock. To update after an intended fixture change,
relabel affected tasks, then regenerate the entries:

```sh
bun -e 'import {hashFixture,LOCK_FILE} from "./tests/helpers/fixture-hash.ts"; const names=["mixed-app","py-ingest","react-dashboard","scope-snapshot","webhook-service"]; const lock={}; for (const n of names) lock[n]=await hashFixture(n); await Bun.write(LOCK_FILE, JSON.stringify(lock,null,2)+"\n")'
```

A changed lock entry means earlier results on that fixture are not comparable with later ones.

### Candidate recall

`bun scripts/recall.ts [fixture ...]` reports, per task, how many `required` labels reach the shortlist before Jev sees
it. It bounds what Jev can select.

## Harness

Not yet written.

## Metrics

Not yet written.
