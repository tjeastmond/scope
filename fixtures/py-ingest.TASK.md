# Fixture tasks: py-ingest

`fixtures/py-ingest/` is "feedflow", a small Python package that polls RSS, Atom and JSON feeds, normalizes and
dedupes their items, and stores them in memory or SQLite. It also holds TOML and YAML configuration, a README and pytest
tests (27 files).

This fixture is source data only. It is never executed, type-checked or linted by the Scope repository (`fixtures/` is
excluded from Prettier, ESLint, `tsc` and `bun test`). Do not rename symbols: the labels depend on them. Any edit
changes the content revision in `tasks/fixtures.lock.json`; see `docs/evaluation.md`.

## Machine-readable labels

`tasks/py-ingest.json` follows the format in `docs/evaluation.md` (labeling guide). Paths are relative to
`fixtures/py-ingest/`.

## Tasks

| Id                        | Split   | Task                                                                    |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| `retry-after-header`      | tuning  | Honor a `Retry-After` header on HTTP 429 instead of the fixed backoff.  |
| `pause-failing-sources`   | tuning  | Leave a source alone for an hour after five consecutive failures.       |
| `longer-summaries`        | tuning  | Raise the summary length limit to 1000 characters.                      |
| `atom-missing-timezone`   | heldout | Treat Atom timestamps without a zone as UTC.                            |
| `ignore-tracking-params`  | heldout | Dedupe links that differ only by `utm_` parameters.                     |
| `prune-old-items`         | heldout | Delete stored items older than the configured retention after each run. |

## What the fixture exercises

- **Same-name and near-miss decoys:** `backoff_delay` (HTTP retries) against the scheduler's `jitter`; three date parsers
  (`parse_timestamp`, `parse_pubdate`, `parse_date_published`); `truncate` against `metrics.shorten`;
  `MemoryStorage` against `SqliteStorage` behind one `Storage` interface; `normalize_url` against fingerprinting.
- **Classes and methods:** dataclasses, an abstract base parser with subclasses, nested `Class.method` chunk names.
- **Low lexical overlap:** several tasks use words that appear nowhere in the answer (`tracking parameters`,
  `left alone for an hour`, `cut off`).
- **Whole-file fallbacks:** `src/feedflow/__init__.py` and `src/feedflow/storage/__init__.py` have no declarations, so
  the analyzer reports a text fallback warning for each. This is expected.
