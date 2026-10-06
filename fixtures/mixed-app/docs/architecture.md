# Architecture

Ledgerly has three processes that share one database.

## API

The API exposes invoices over HTTP. Routes live in `api/src/routes/` and delegate to `InvoiceService`.

### Validation

Request bodies are checked with `validateInvoice` before they reach the service.

## Worker

The reminder worker polls the `reminders` queue and emails customers whose invoices are close to their due date.

### Retries

A failed reminder is retried with exponential backoff, up to `max_attempts` from `config/app.toml`.

## Frontend

The React app lists invoices and shows their status.
