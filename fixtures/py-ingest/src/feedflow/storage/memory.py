from __future__ import annotations

from ..dedupe import item_fingerprint
from ..models import FeedItem


class MemoryStorage:
    """Keeps everything in a dict; used by tests."""

    def __init__(self) -> None:
        self.items: dict[str, FeedItem] = {}

    def known_fingerprints(self) -> set[str]:
        return set(self.items)

    def save_items(self, items: list[FeedItem]) -> int:
        written = 0
        for item in items:
            key = item_fingerprint(item)
            if key not in self.items:
                self.items[key] = item
                written += 1
        return written

    def count_items(self, source: str | None = None) -> int:
        if source is None:
            return len(self.items)
        return sum(1 for item in self.items.values() if item.source == source)
