from __future__ import annotations

from typing import Protocol

from ..models import FeedItem


class Storage(Protocol):
    """Where items and the set of known fingerprints live."""

    def known_fingerprints(self) -> set[str]: ...

    def save_items(self, items: list[FeedItem]) -> int:
        """Persist items and return how many rows were written."""
        ...

    def count_items(self, source: str | None = None) -> int: ...
