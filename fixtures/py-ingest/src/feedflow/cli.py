from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone

from . import metrics
from .pipeline import run_once
from .scheduler import Scheduler
from .settings import load_settings, load_sources
from .storage import SqliteStorage


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="feedflow", description="Feed ingestion worker")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="poll sources until interrupted")
    run.add_argument("--config", default="config/ingest.toml")
    run.add_argument("--feeds", default="config/feeds.yaml")
    run.add_argument("--once", action="store_true", help="poll due sources once and exit")

    validate = commands.add_parser("validate", help="check the configuration files")
    validate.add_argument("--config", default="config/ingest.toml")
    validate.add_argument("--feeds", default="config/feeds.yaml")
    return parser


def cmd_run(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    sources = load_sources(args.feeds)
    storage = SqliteStorage(settings.database_path)
    scheduler = Scheduler(default_interval_seconds=settings.poll_interval_seconds)
    try:
        while True:
            for report in run_once(sources, settings, storage, scheduler):
                metrics.record(report)
                status = report.error or f"{report.stored} new, {report.duplicates} duplicates"
                print(f"{datetime.now(timezone.utc):%H:%M:%S} {report.source}: {status}")
            if args.once:
                return 0
            time.sleep(5)
    except KeyboardInterrupt:
        return 130
    finally:
        storage.close()


def cmd_validate(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    sources = load_sources(args.feeds)
    print(f"{len(sources)} sources, database at {settings.database_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {"run": cmd_run, "validate": cmd_validate}
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
