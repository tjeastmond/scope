from feedflow.models import FeedItem
from feedflow.storage import MemoryStorage, SqliteStorage


def test_memory_storage_counts_by_source():
    storage = MemoryStorage()
    storage.save_items([FeedItem(source="a", title="x", link="https://e.org/1")])
    assert storage.count_items("a") == 1 and storage.count_items("b") == 0


def test_sqlite_storage_ignores_duplicates(tmp_path):
    storage = SqliteStorage(tmp_path / "items.db")
    item = FeedItem(source="a", title="x", link="https://e.org/1")
    storage.save_items([item])
    storage.save_items([item])
    assert storage.count_items() == 1
    storage.close()
