from __future__ import annotations

import json
from datetime import datetime

from ..models import FeedItem, FeedSource
from ..text import clean_summary
from .base import BaseParser, ParseError


def parse_date_published(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class JsonFeedParser(BaseParser):
    format = "jsonfeed"

    def parse(self, body: str, source: FeedSource) -> list[FeedItem]:
        try:
            document = json.loads(body)
        except json.JSONDecodeError as error:
            raise ParseError(f"{source.name}: invalid JSON Feed: {error}") from error
        return [self.parse_entry(entry, source) for entry in document.get("items", [])]

    def parse_entry(self, entry: dict, source: FeedSource) -> FeedItem:
        published = parse_date_published(entry.get("date_published"))
        return FeedItem(
            source=source.name,
            title=(entry.get("title") or "").strip(),
            link=entry.get("url", ""),
            summary=clean_summary(entry.get("summary") or entry.get("content_text") or "", self.max_summary_chars),
            published_at=self.ensure_utc(published) if published else None,
            tags=list(entry.get("tags", [])),
        )
