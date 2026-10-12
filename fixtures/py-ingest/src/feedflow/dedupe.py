from __future__ import annotations

import hashlib
from urllib.parse import urlsplit, urlunsplit

from .models import FeedItem


def normalize_url(url: str) -> str:
    """Lowercase the host, drop the fragment and any trailing slash so equal links compare equal."""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def item_fingerprint(item: FeedItem) -> str:
    """Stable identity of an item across polls."""
    basis = f"{normalize_url(item.link)}|{item.title.strip().lower()}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def dedupe_items(items: list[FeedItem], seen: set[str]) -> tuple[list[FeedItem], int]:
    """Return the items not seen before, plus how many were dropped. `seen` is updated in place."""
    fresh: list[FeedItem] = []
    dropped = 0
    for item in items:
        fingerprint = item_fingerprint(item)
        if fingerprint in seen:
            dropped += 1
            continue
        seen.add(fingerprint)
        fresh.append(item)
    return fresh, dropped
