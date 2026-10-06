import functools
import time

from format import format
from validate import validate

BACKOFF_SECONDS = 30


def retry(times: int):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(times):
                try:
                    return fn(*args, **kwargs)
                except OSError:
                    time.sleep(BACKOFF_SECONDS * 2**attempt)
            raise RuntimeError("reminder failed after retries")

        return wrapper

    return decorator


@retry(times=5)
def send_reminder(job) -> None:
    problems = validate({"email": job.email})
    if problems:
        raise ValueError(", ".join(problems))
    print(format("Reminder for invoice {}", job.invoice_id))


def schedule(jobs: list) -> list:
    def due_first(job):
        return job.attempts

    return sorted(jobs, key=due_first)
