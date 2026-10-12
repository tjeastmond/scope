from __future__ import annotations

import time

import requests

from .models import FeedSource
from .settings import Settings

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class FetchError(Exception):
    pass


def build_headers(settings: Settings) -> dict[str, str]:
    return {"User-Agent": settings.user_agent, "Accept": "application/rss+xml, application/atom+xml, application/json"}


def backoff_delay(attempt: int) -> float:
    """Seconds to wait before HTTP retry number `attempt` (1-based): 1, 2, 4, ... capped at 30."""
    return min(2 ** (attempt - 1), 30)


def fetch_feed(source: FeedSource, settings: Settings) -> str:
    """Download a feed body, retrying transient HTTP failures."""
    last_error: Exception | None = None
    for attempt in range(1, settings.max_retries + 2):
        try:
            response = requests.get(source.url, headers=build_headers(settings), timeout=settings.timeout_seconds)
            if response.status_code in RETRYABLE_STATUS:
                raise FetchError(f"{source.name}: HTTP {response.status_code}")
            response.raise_for_status()
            return response.text
        except (requests.RequestException, FetchError) as error:
            last_error = error
            if attempt > settings.max_retries:
                break
            time.sleep(backoff_delay(attempt))
    raise FetchError(f"{source.name}: giving up after {settings.max_retries + 1} attempts: {last_error}")
