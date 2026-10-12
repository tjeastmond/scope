from feedflow.models import FeedSource
from feedflow.parsers import get_parser
from feedflow.parsers.rss import parse_pubdate

RSS = """<rss><channel><item><title>Hello</title><link>https://example.org/a</link>
<description>&lt;p&gt;Body&lt;/p&gt;</description><pubDate>Tue, 03 Jun 2025 09:30:00 GMT</pubDate></item></channel></rss>"""

SOURCE = FeedSource(name="blog", url="https://example.org/feed.xml", format="rss")


def test_rss_item_is_normalized():
    items = get_parser("rss").parse(RSS, SOURCE)
    assert [item.title for item in items] == ["Hello"]
    assert items[0].published_at is not None


def test_parse_pubdate_rejects_garbage():
    assert parse_pubdate("not a date") is None
