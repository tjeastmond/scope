from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime

from ..models import FeedItem, FeedSource
from ..text import clean_summary
from .base import BaseParser, ParseError

NS = {"a": "http://www.w3.org/2005/Atom"}


def parse_timestamp(value: str | None) -> datetime | None:
    """Atom dates are RFC 3339: `2025-06-03T09:30:00Z`."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class AtomParser(BaseParser):
    format = "atom"

    def parse(self, body: str, source: FeedSource) -> list[FeedItem]:
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise ParseError(f"{source.name}: invalid Atom document: {error}") from error
        return [self.parse_entry(entry, source) for entry in root.findall("a:entry", NS)]

    def parse_entry(self, entry: ET.Element, source: FeedSource) -> FeedItem:
        link_node = entry.find("a:link[@rel='alternate']", NS)
        if link_node is None:
            link_node = entry.find("a:link", NS)
        published = parse_timestamp(entry.findtext("a:published", namespaces=NS))
        summary = entry.findtext("a:summary", namespaces=NS) or entry.findtext("a:content", namespaces=NS) or ""
        return FeedItem(
            source=source.name,
            title=(entry.findtext("a:title", namespaces=NS) or "").strip(),
            link=link_node.get("href", "") if link_node is not None else "",
            summary=clean_summary(summary, self.max_summary_chars),
            published_at=self.ensure_utc(published) if published else None,
        )
