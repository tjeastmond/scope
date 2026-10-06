# Ledgerly

Ledgerly is a small invoicing app: a React frontend, a Node API, a Python worker that sends reminders, and a Postgres
schema. It exists as a fixture for Scope and is never run.

## Layout

- `web/` React + TypeScript frontend
- `api/` Node + TypeScript HTTP API
- `worker/` Python reminder worker
- `db/` SQL migrations and queries
- `config/` TOML and JSON configuration
