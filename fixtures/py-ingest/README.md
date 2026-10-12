# feedflow

A small feed-ingestion worker. It polls RSS, Atom and JSON Feed sources on a schedule, normalizes the entries into
`FeedItem` records, removes duplicates and stores them in SQLite.

## Layout

- `src/feedflow/parsers/` one parser per feed format, selected by the source's `format`
- `src/feedflow/fetch.py` HTTP fetching with retries
- `src/feedflow/dedupe.py` fingerprinting and duplicate removal
- `src/feedflow/scheduler.py` decides when each source is due
- `src/feedflow/storage/` the storage interface, the SQLite adapter and an in-memory adapter for tests
- `src/feedflow/cli.py` the `feedflow` command

## Running

```
feedflow run --config config/ingest.toml
feedflow validate --config config/ingest.toml
```

## Configuration

`config/ingest.toml` holds worker settings (database path, polling interval, user agent). `config/feeds.yaml` lists the
sources. Settings are loaded by `feedflow.settings.load_settings`.

## Tests

```
pytest tests
```
