from dataclasses import dataclass, field
from typing import Iterator


@dataclass
class Job:
    invoice_id: str
    email: str
    attempts: int = 0


class ReminderQueue:
    """A tiny in-memory queue standing in for the real broker."""

    class Stats:
        """Counters kept per queue."""

        def __init__(self) -> None:
            self.polled = 0
            self.failed = 0

        def record(self, ok: bool) -> None:
            self.polled += 1
            if not ok:
                self.failed += 1

    def __init__(self, name: str) -> None:
        self.name = name
        self.jobs: list[Job] = []
        self.stats = ReminderQueue.Stats()

    def push(self, job: Job) -> None:
        self.jobs.append(job)

    def poll(self) -> Iterator[Job]:
        while self.jobs:
            self.stats.record(True)
            yield self.jobs.pop(0)

    @property
    def depth(self) -> int:
        return len(self.jobs)
