from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .models import FeedSource

JITTER_FRACTION = 0.1


def jitter(seconds: float, fraction: float = JITTER_FRACTION) -> float:
    """Spread polls out so sources do not all fire on the same second."""
    return seconds + random.uniform(0, seconds * fraction)


@dataclass
class SourceState:
    last_run: datetime | None = None
    consecutive_failures: int = 0


@dataclass
class Scheduler:
    """Tracks when each source is next due."""

    default_interval_seconds: int
    states: dict[str, SourceState] = field(default_factory=dict)

    def interval_for(self, source: FeedSource) -> int:
        return source.poll_interval_seconds or self.default_interval_seconds

    def next_run(self, source: FeedSource) -> datetime:
        state = self.states.get(source.name)
        if state is None or state.last_run is None:
            return datetime.min.replace(tzinfo=timezone.utc)
        return state.last_run + timedelta(seconds=jitter(self.interval_for(source)))

    def due(self, sources: list[FeedSource], now: datetime) -> list[FeedSource]:
        return [source for source in sources if self.next_run(source) <= now]

    def record_success(self, source: FeedSource, now: datetime) -> None:
        self.states[source.name] = SourceState(last_run=now, consecutive_failures=0)

    def record_failure(self, source: FeedSource, now: datetime) -> None:
        state = self.states.setdefault(source.name, SourceState())
        state.last_run = now
        state.consecutive_failures += 1
