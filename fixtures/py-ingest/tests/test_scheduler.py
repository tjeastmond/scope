from datetime import datetime, timezone

from feedflow.models import FeedSource
from feedflow.scheduler import Scheduler

SOURCE = FeedSource(name="blog", url="https://example.org/feed.xml", format="rss")


def test_new_source_is_due_immediately():
    scheduler = Scheduler(default_interval_seconds=900)
    assert scheduler.due([SOURCE], datetime.now(timezone.utc)) == [SOURCE]


def test_failure_counter_resets_on_success():
    scheduler = Scheduler(default_interval_seconds=900)
    now = datetime.now(timezone.utc)
    scheduler.record_failure(SOURCE, now)
    scheduler.record_success(SOURCE, now)
    assert scheduler.states["blog"].consecutive_failures == 0
