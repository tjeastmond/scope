from __future__ import annotations

from datetime import datetime, timezone

from .dedupe import dedupe_items
from .fetch import FetchError, fetch_feed
from .models import FeedSource, IngestReport
from .parsers import ParseError, get_parser
from .scheduler import Scheduler
from .settings import Settings
from .storage import Storage


def ingest_source(source: FeedSource, settings: Settings, storage: Storage) -> IngestReport:
    """Fetch, parse, dedupe and store one source. Failures are reported, not raised."""
    report = IngestReport(source=source.name)
    try:
        body = fetch_feed(source, settings)
        items = get_parser(source.format, settings.max_summary_chars).parse(body, source)
    except (FetchError, ParseError) as error:
        report.error = str(error)
        return report
    report.fetched = len(items)
    fresh, dropped = dedupe_items(items, storage.known_fingerprints())
    report.duplicates = dropped
    report.stored = storage.save_items(fresh)
    return report


def run_once(
    sources: list[FeedSource], settings: Settings, storage: Storage, scheduler: Scheduler
) -> list[IngestReport]:
    """Ingest every source that is due right now."""
    now = datetime.now(timezone.utc)
    reports = []
    for source in scheduler.due(sources, now):
        report = ingest_source(source, settings, storage)
        if report.error:
            scheduler.record_failure(source, now)
        else:
            scheduler.record_success(source, now)
        reports.append(report)
    return reports
