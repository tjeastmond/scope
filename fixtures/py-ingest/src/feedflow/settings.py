from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

import yaml

from .models import FeedSource

DEFAULT_TIMEOUT_SECONDS = 10
DEFAULT_POLL_INTERVAL_SECONDS = 900
DEFAULT_MAX_SUMMARY_CHARS = 400


@dataclass(frozen=True)
class Settings:
    database_path: str
    user_agent: str
    poll_interval_seconds: int = DEFAULT_POLL_INTERVAL_SECONDS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    max_retries: int = 3
    max_summary_chars: int = DEFAULT_MAX_SUMMARY_CHARS
    keep_days: int = 90


def load_settings(path: str | Path) -> Settings:
    """Read worker settings from a TOML file."""
    with open(path, "rb") as handle:
        raw = tomllib.load(handle)
    worker = raw.get("worker", {})
    http = raw.get("http", {})
    items = raw.get("items", {})
    return Settings(
        database_path=worker.get("database_path", "feedflow.db"),
        user_agent=worker.get("user_agent", "feedflow"),
        poll_interval_seconds=worker.get("poll_interval_seconds", DEFAULT_POLL_INTERVAL_SECONDS),
        timeout_seconds=http.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS),
        max_retries=http.get("max_retries", 3),
        max_summary_chars=items.get("max_summary_chars", DEFAULT_MAX_SUMMARY_CHARS),
        keep_days=items.get("keep_days", 90),
    )


def load_sources(path: str | Path) -> list[FeedSource]:
    """Read the list of feeds from a YAML file."""
    with open(path, encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)
    return [
        FeedSource(
            name=entry["name"],
            url=entry["url"],
            format=entry["format"],
            poll_interval_seconds=entry.get("poll_interval_seconds"),
        )
        for entry in raw.get("sources", [])
    ]
