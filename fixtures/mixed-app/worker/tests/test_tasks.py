import pytest

from queue_client import Job, ReminderQueue
from tasks import schedule
from validate import validate


def test_schedule_orders_by_attempts():
    jobs = [Job("a", "a@example.com", 2), Job("b", "b@example.com", 0)]
    assert [job.invoice_id for job in schedule(jobs)] == ["b", "a"]


def test_validate_requires_at_sign():
    assert validate({"email": "nope"}) == ["email must contain @"]


class TestReminderQueue:
    def test_poll_drains_queue(self):
        queue = ReminderQueue("reminders")
        queue.push(Job("a", "a@example.com"))
        assert len(list(queue.poll())) == 1
        assert queue.depth == 0

    @pytest.mark.parametrize("count", [0, 3])
    def test_depth(self, count):
        queue = ReminderQueue("reminders")
        for index in range(count):
            queue.push(Job(str(index), "x@example.com"))
        assert queue.depth == count
