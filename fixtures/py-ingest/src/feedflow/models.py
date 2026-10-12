from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class FeedSource:
    """One configured feed."""

    name: str
    url: str
    format: str
    poll_interval_seconds: int | None = None


@dataclass
class FeedItem:
    """A normalized entry, whatever format it came from."""

    source: str
    title: str
    link: str
    summary: str = ""
    published_at: datetime | None = None
    tags: list[str] = field(default_factory=list)

    def display_title(self) -> str:
        return self.title.strip() or "(untitled)"


@dataclass
class IngestReport:
    source: str
    fetched: int = 0
    stored: int = 0
    duplicates: int = 0
    error: str | None = None
