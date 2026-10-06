# Fixture tasks: mixed-app

`fixtures/mixed-app/` is "Ledgerly", a small invoicing app: a React TSX frontend (`web/`), a Node TypeScript API
(`api/`), a Python reminder worker (`worker/`), SQL (`db/`), CSS/SCSS, TOML/JSON/YAML configuration and Markdown docs.

This fixture is source data only. It is never executed, type-checked, linted or formatted by the Scope repository
(`fixtures/` is excluded from Prettier, ESLint, `tsc` and `bun test`), and the CRLF and broken files must stay exactly as
they are. Do not rename symbols: the labels below depend on them.

## Machine-readable labels

`tasks/mixed-app.json` is an array of `{ id, split, task, required[], useful[], irrelevant[] }`. `split` is `tuning`
(retrieval may be tuned on it) or `heldout` (kept to measure generalization; never tune on it). Each entry in the three
lists is a chunk label:

- `path::symbol` is the chunk whose `file` is `path` (relative to `fixtures/mixed-app/`) and whose `name` is `symbol`,
  exactly as the analyzers name it (`InvoiceService.create`, `Billing.Ledger`, `Architecture > Worker > Retries`).
- `path::symbol@start-end` adds the chunk's 1-based inclusive line range, for the rare case where a file has two chunks
  with the same name (`db/queries/invoices.sql` has two `select from invoices`).
- A bare `path` (no `::`) labels a whole-file chunk and is valid only for a file that analyzes to exactly one chunk.

Every label must resolve to exactly one chunk and no label may appear twice across the three lists of a task. This is
enforced by `tests/mixed-fixture.test.ts`.

| List         | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `required`   | The change cannot be made correctly without these chunks.  |
| `useful`     | Helpful context, but the change can be made without them.  |
| `irrelevant` | Not needed, including near-misses and same-name decoys.    |

## Tasks

| Id                              | Languages                       | Task                                                       |
| ------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `due-date-column`               | TSX frontend, TS API, SQL       | Show the due date in the invoice list.                     |
| `configurable-reminder-retries` | Python, TOML, Markdown, SQL     | Make reminder retries configurable from `config/app.toml`. |
| `localized-csv-export`          | TS (CRLF file, Unicode strings) | Add a localized status column to the CSV export.           |

## What the fixture exercises

- **Duplicate names:** `format` in `web/src/lib/format.ts`, `api/src/util/format.ts` and `worker/format.py`; `validate` in
  `web/src/lib/validate.ts`, `api/src/util/validate.ts` and `worker/validate.py`.
- **Nesting:** namespace `Billing` containing the class `Billing.Ledger` (`api/src/models/invoice.ts`); nested Python
  class `ReminderQueue.Stats` (`worker/queue_client.py`); nested functions in `worker/tasks.py` (`retry` and `schedule`).
- **Unicode:** identifiers and strings in `api/src/i18n/messages.ts`, `web/src/components/Greeting.tsx`,
  `worker/names.py`.
- **CRLF:** `api/src/util/csv.ts` uses CRLF line endings (kept byte-exact by `.gitattributes`).
- **Deliberately broken:** `api/src/broken/report.ts` is truncated mid-expression. It is still eligible; the analyzer
  keeps `summarize` and the text fallback covers the rest.
- **Python entry point:** `worker/main.py` ends with an `if __name__ == "__main__":` guard (chunk `__main__`).

## Intended scanner classification

Eligible: every file except the two below, 41 in all.

| Path                            | Classification           | Why                                                                     |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `.env.example`                  | skipped, reason `secret` | `.env.*` is a secret name pattern; it holds placeholders only.          |
| `web/src/vendor/tracker.min.js` | skipped, `minified`      | `*.min.js` is treated as generated.                                     |

There is no lockfile and no real credential in the fixture. A `dist/` directory would also be skipped, but the repository
`.gitignore` ignores `dist`, so none is committed.
