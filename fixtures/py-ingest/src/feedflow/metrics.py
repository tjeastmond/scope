from __future__ import annotations

from collections import Counter

from .models import IngestReport

_counters: Counter[str] = Counter()


def record(report: IngestReport) -> None:
    _counters["fetched"] += report.fetched
    _counters["stored"] += report.stored
    _counters["duplicates"] += report.duplicates
    if report.error:
        _counters["errors"] += 1


def snapshot() -> dict[str, int]:
    return dict(_counters)


def shorten(value: str, limit: int = 60) -> str:
    """Trim a label for log lines."""
    return value if len(value) <= limit else value[: limit - 3] + "..."
