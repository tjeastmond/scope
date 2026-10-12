from __future__ import annotations

import html
import re

_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def strip_html(value: str) -> str:
    """Remove markup and decode entities."""
    return html.unescape(_TAG.sub(" ", value))


def normalize_whitespace(value: str) -> str:
    return _SPACE.sub(" ", value).strip()


def truncate(value: str, limit: int) -> str:
    """Cut a summary to `limit` characters, adding an ellipsis when something was removed."""
    if len(value) <= limit:
        return value
    return value[: max(limit - 1, 0)].rstrip() + "…"


def clean_summary(value: str, limit: int) -> str:
    return truncate(normalize_whitespace(strip_html(value)), limit)
