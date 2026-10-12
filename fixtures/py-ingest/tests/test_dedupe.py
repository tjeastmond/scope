from feedflow.dedupe import dedupe_items, normalize_url
from feedflow.models import FeedItem


def make(link: str) -> FeedItem:
    return FeedItem(source="blog", title="Hello", link=link)


def test_normalize_url_ignores_case_and_fragment():
    assert normalize_url("HTTPS://Example.org/a/#top") == normalize_url("https://example.org/a")


def test_dedupe_drops_repeats():
    seen: set[str] = set()
    fresh, dropped = dedupe_items([make("https://example.org/a"), make("https://example.org/a/")], seen)
    assert len(fresh) == 1 and dropped == 1
