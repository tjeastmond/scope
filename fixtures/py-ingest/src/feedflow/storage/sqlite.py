from __future__ import annotations

import sqlite3
from pathlib import Path

from ..dedupe import item_fingerprint
from ..models import FeedItem

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    fingerprint TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    summary TEXT NOT NULL,
    published_at TEXT,
    stored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS items_source ON items (source);
"""


class SqliteStorage:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.executescript(SCHEMA)

    def known_fingerprints(self) -> set[str]:
        rows = self.connection.execute("SELECT fingerprint FROM items")
        return {row[0] for row in rows}

    def save_items(self, items: list[FeedItem]) -> int:
        rows = [
            (
                item_fingerprint(item),
                item.source,
                item.title,
                item.link,
                item.summary,
                item.published_at.isoformat() if item.published_at else None,
            )
            for item in items
        ]
        with self.connection:
            cursor = self.connection.executemany(
                "INSERT OR IGNORE INTO items (fingerprint, source, title, link, summary, published_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
        return cursor.rowcount

    def count_items(self, source: str | None = None) -> int:
        if source is None:
            return self.connection.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        return self.connection.execute("SELECT COUNT(*) FROM items WHERE source = ?", (source,)).fetchone()[0]

    def close(self) -> None:
        self.connection.close()
