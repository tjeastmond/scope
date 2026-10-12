# Pulseboard

An operations dashboard: live metric cards, an alert feed and a settings page. React 18 with TypeScript, a tiny
external store and CSS modules.

## Structure

- `src/api/` the HTTP client and typed calls for metrics and alerts
- `src/store/` the application store and its selectors
- `src/hooks/` data and utility hooks
- `src/components/` presentational components
- `src/pages/` one component per route (see `src/routes.tsx`)
- `public/dashboard.config.json` which widgets appear and how often they refresh

## Scripts

```
npm run dev
npm test
```

## Notes

- Timestamps from the API are ISO strings in UTC.
- The refresh interval and the visible widgets come from `dashboard.config.json`, read once at startup by
  `loadConfig`.
