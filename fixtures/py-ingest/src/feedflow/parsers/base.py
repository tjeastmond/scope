from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from ..models import FeedItem, FeedSource


class ParseError(Exception):
    """The document could not be understood as the expected format."""


class BaseParser(ABC):
    """Turns a fetched document into FeedItem records."""

    format: str = ""

    def __init__(self, max_summary_chars: int = 400) -> None:
        self.max_summary_chars = max_summary_chars

    @abstractmethod
    def parse(self, body: str, source: FeedSource) -> list[FeedItem]:
        """Return the items in `body`, newest first when the feed says so."""

    @staticmethod
    def ensure_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
