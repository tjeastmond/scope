"""Entry point for the reminder worker."""
import logging

from queue_client import ReminderQueue
from tasks import send_reminder

MAX_ATTEMPTS = 5

log = logging.getLogger("worker")


def run_once(queue: ReminderQueue) -> int:
    handled = 0
    for job in queue.poll():
        send_reminder(job)
        handled += 1
    return handled


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    queue = ReminderQueue("reminders")
    log.info("handled %d jobs", run_once(queue))


if __name__ == "__main__":
    main()
