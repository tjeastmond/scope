-- Reminders scan invoices by status and due date.
CREATE INDEX idx_invoices_status_due ON invoices (status, due_date);

ALTER TABLE invoices ADD COLUMN reminder_attempts integer NOT NULL DEFAULT 0;
