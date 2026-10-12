# Fixture tasks: scope-snapshot

`fixtures/scope-snapshot/` is a verbatim, unmodified copy of Scope's own `src/` directory plus `package.json` and
`README.md`, taken from commit `b33c9b7` (52 files). It is a realistic, larger TypeScript codebase with many
helper names that recur across modules.

Source commit: `b33c9b7` (main at the time the evaluation set was grown). Do not edit these files and do not refresh
them as `src/` evolves: the labels and the content revision in `tasks/fixtures.lock.json` are pinned to this snapshot. To
move to a newer snapshot, copy again, relabel, and update the lock deliberately (see `docs/evaluation.md`).

This fixture is source data only. It is never executed, type-checked or linted from `fixtures/` (excluded from Prettier,
ESLint, `tsc` and `bun test`).

## Machine-readable labels

`tasks/scope-snapshot.json` follows the format in `docs/evaluation.md` (labeling guide). Paths are relative to
`fixtures/scope-snapshot/`.

## Tasks

| Id                      | Split   | Task                                                            |
| ----------------------- | ------- | --------------------------------------------------------------- |
| `max-candidates-flag`   | tuning  | Add a `--max-candidates` flag limiting candidates sent to Jev.  |
| `redact-more-secrets`   | tuning  | Mask Slack and npm style tokens before code leaves the machine. |
| `min-relevance-flag`    | tuning  | Let users raise the relevance cutoff from the command line.     |
| `jev-timeout-message`   | tuning  | Say how long was waited and name the deadline on a Jev timeout. |
| `skip-generated-folders`| heldout | Skip `vendor/` and `generated/` when scanning.                  |
| `score-in-markdown`     | heldout | Show each region's relevance beside its path in markdown.       |

## What the fixture exercises

- **Same-name decoys across modules:** `stem` (`retrieval/terms.ts`, `graph/tests.ts`), `compareChunks`
  (`retrieval/candidates.ts`, `retrieval/indexes.ts`), `requirePositiveInteger`, `isCount`, `byLocation`,
  `renderRegion` (`output/markdown.ts`, `output/text.ts`), `namedChildren` and `Found` in several analyzers.
- **Constants as chunks:** top-level exported constants in `src/config.ts` are `config` chunks
  (`MAX_CANDIDATES`, `MIN_RELEVANCE`, `JEV_DEADLINE_MS`).
- **Low lexical overlap:** tasks phrased in user terms (`only the strongest matches`, `how long we waited`) rather than
  identifier names.
- **Size:** about 400 chunks, so the candidate shortlist matters.
