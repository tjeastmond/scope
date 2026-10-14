# Fixture tasks: react-dashboard

`fixtures/react-dashboard/` is "Pulseboard", a small React and TypeScript metrics dashboard: components, hooks, a tiny
store with selectors, an API client, routes, CSS modules, a JSON runtime config and Vitest tests (35 files).

This fixture is source data only. It is never executed, type-checked or linted by the Scope repository (`fixtures/` is
excluded from Prettier, ESLint, `tsc` and `bun test`). Do not rename symbols: the labels depend on them. Any edit
changes the content revision in `tasks/fixtures.lock.json`; see `docs/evaluation.md`.

## Machine-readable labels

`tasks/react-dashboard.json` follows the format in `docs/evaluation.md` (labeling guide). Paths are relative to
`fixtures/react-dashboard/`.

## Tasks

| Id                          | Split   | Task                                                                  |
| --------------------------- | ------- | --------------------------------------------------------------------- |
| `poll-interval-from-config` | tuning  | Poll at the interval in the dashboard config, not a hardcoded value.  |
| `hide-acknowledged-alerts`  | tuning  | Hide handled alerts by default, with a toggle.                        |
| `alert-age-over-a-day`      | tuning  | Show days for alert ages beyond 24 hours.                             |
| `sidenav-theme-toggle`      | tuning  | Add a theme toggle link to the sidenav.                               |
| `bearer-token`              | heldout | Send a bearer token with every backend request.                       |
| `plain-number-format`       | heldout | Format request rates with a thousands separator instead of `1.2k`.    |
| `remember-time-range`       | heldout | Persist the selected time range across reloads.                       |

## What the fixture exercises

- **Duplicate names:** `formatDuration` exists in both `src/lib/format.ts` (milliseconds) and `src/lib/dates.ts` (age of
  an alert); `format*` helpers sit side by side.
- **A hardcoded constant behind a config value:** `useMetrics` refreshes on a local `REFRESH_MS` while the JSON config
  holds `refreshIntervalSeconds`.
- **Layers:** page, component, hook, store, selector and API client, so most changes touch two or three layers.
- **Mixed file kinds:** TSX, TS, CSS modules, JSON and a Vite config. CSS rules are chunks (`.badge`, `.card`).
- **Whole-file fallback:** `src/main.tsx` has no declarations and produces one text fallback warning. This is expected.
