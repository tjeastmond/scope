from __future__ import annotations

from .atom import AtomParser
from .base import BaseParser, ParseError
from .jsonfeed import JsonFeedParser
from .rss import RssParser

PARSERS: dict[str, type[BaseParser]] = {
    "rss": RssParser,
    "atom": AtomParser,
    "jsonfeed": JsonFeedParser,
}


def get_parser(format_name: str, max_summary_chars: int = 400) -> BaseParser:
    try:
        return PARSERS[format_name](max_summary_chars=max_summary_chars)
    except KeyError:
        raise ParseError(f"unknown feed format: {format_name}") from None


__all__ = ["BaseParser", "ParseError", "PARSERS", "get_parser"]
