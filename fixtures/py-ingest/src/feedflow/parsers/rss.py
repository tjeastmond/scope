from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime

from ..models import FeedItem, FeedSource
from ..text import clean_summary
from .base import BaseParser, ParseError


def parse_pubdate(value: str | None) -> datetime | None:
    """RSS dates are RFC 822: `Tue, 03 Jun 2025 09:30:00 GMT`."""
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None


class RssParser(BaseParser):
    format = "rss"

    def parse(self, body: str, source: FeedSource) -> list[FeedItem]:
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise ParseError(f"{source.name}: invalid RSS document: {error}") from error
        items = []
        for node in root.iter("item"):
            items.append(self.parse_item(node, source))
        return items

    def parse_item(self, node: ET.Element, source: FeedSource) -> FeedItem:
        published = parse_pubdate(node.findtext("pubDate"))
        return FeedItem(
            source=source.name,
            title=(node.findtext("title") or "").strip(),
            link=(node.findtext("link") or "").strip(),
            summary=clean_summary(node.findtext("description") or "", self.max_summary_chars),
            published_at=self.ensure_utc(published) if published else None,
            tags=[c.text.strip() for c in node.findall("category") if c.text],
        )
