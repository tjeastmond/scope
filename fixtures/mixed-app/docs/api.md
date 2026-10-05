# HTTP API

## GET /invoices

Returns a page of invoices. Query: `status`, `limit`.

## POST /invoices

Creates an invoice. Responds with `201` and the stored invoice.

## GET /health

Returns `{"ok": true}`.
