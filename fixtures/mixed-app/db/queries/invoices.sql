-- Invoices that need a reminder.
SELECT i.id, i.number, c.email
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.status = 'open' AND i.due_date <= current_date + 3 AND i.reminded_at IS NULL;

-- Record that a reminder went out.
UPDATE invoices SET reminded_at = now(), reminder_attempts = reminder_attempts + 1 WHERE id = $1;

-- Page of invoices by status.
SELECT id, number, total_cents, status FROM invoices WHERE status = $1 ORDER BY due_date LIMIT $2;
