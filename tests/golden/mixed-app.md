# Scope context

Task:

```text
Show each invoice's due date in the invoice list: render it in the frontend row (the API already returns dueDate).
```

- Mode: jev
- Regions: 12
- Retrieval config: ` retrieval-v4 `
- Jev questions: ` relevance-v1 `

## Warnings

- ` api/src/broken/report.ts: syntax errors; extracted 1 declarations from the parseable regions `
- ` api/src/broken/report.ts: syntax errors; text fallback produced 2 line window(s) over the lines the parser did not recover `
- ` web/src/main.tsx: analyzer extracted no chunks; text fallback produced 1 line window(s) `
- ` 1 file(s) have no analyzer and were read as plain text windows (for example worker/requirements.txt) `

## ` api/src/models/invoice.ts:1-1 `

- Language: typescript
- ` Billing `, section, lines 1-1: supporting declaration

```typescript
export namespace Billing {
```

## ` api/src/models/invoice.ts:10-14 `

- Language: typescript
- ` Billing.Invoice `, interface, lines 10-14: relevance 0.70

```typescript
  export interface Invoice extends InvoiceInput {
    id: string;
    status: Status;
    dueDate: string;
  }
```

## ` api/src/routes/invoices.ts:13-16 `

- Language: typescript
- ` listInvoices `, function, lines 13-16: relevance 0.70

```typescript
export async function listInvoices(status: Billing.Status, res: Response): Promise<void> {
  const invoices = await service.listByStatus(status);
  res.end(JSON.stringify(invoices.map((invoice) => ({ ...invoice, total: format(invoice.totalCents) }))));
}
```

## ` api/src/services/invoiceService.ts:3-5 `

- Language: typescript
- ` InvoiceService `, class, lines 3-5: supporting declaration

```typescript
export class InvoiceService {
  private readonly store = new Map<string, Billing.Invoice>();
  private sequence = 0;
```

## ` api/src/services/invoiceService.ts:14-16 `

- Language: typescript
- ` InvoiceService.listByStatus `, method, lines 14-16: relevance 0.70

```typescript
  async listByStatus(status: Billing.Status): Promise<Billing.Invoice[]> {
    return [...this.store.values()].filter((invoice) => invoice.status === status);
  }
```

## ` api/src/services/invoiceService.ts:25-29 `

- Language: typescript
- ` InvoiceService.dueDateFrom `, method, lines 25-29: relevance 0.70

```typescript
  private dueDateFrom(start: Date): string {
    const due = new Date(start);
    due.setDate(due.getDate() + 30);
    return due.toISOString().slice(0, 10);
  }
```

## ` db/migrations/001_create_invoices.sql:8-16 `

- Language: sql
- ` invoices `, table, lines 8-16: relevance 0.70

```sql
CREATE TABLE invoices (
  id text PRIMARY KEY,
  number text NOT NULL UNIQUE,
  customer_id text NOT NULL REFERENCES customers (id),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  status text NOT NULL DEFAULT 'open',
  due_date date NOT NULL,
  reminded_at timestamptz
);
```

## ` web/src/components/InvoiceList.tsx:9-18 `

- Language: typescript
- ` InvoiceList `, component, lines 9-18: relevance 0.70

```typescript
export function InvoiceList({ invoices }: InvoiceListProps) {
  if (invoices.length === 0) return <p className={styles.empty}>No invoices yet.</p>;
  return (
    <ul className={styles.list}>
      {invoices.map((invoice) => (
        <InvoiceRow key={invoice.id} invoice={invoice} />
      ))}
    </ul>
  );
}
```

## ` web/src/components/InvoiceRow.tsx:5-13 `

- Language: typescript
- ` InvoiceRow `, component, lines 5-13: relevance 0.95

```typescript
export function InvoiceRow({ invoice }: { invoice: InvoiceDto }) {
  const overdue = invoice.status === "overdue";
  return (
    <li className={overdue ? styles.overdue : styles.row}>
      <span>{invoice.number}</span>
      <span>{format(invoice.totalCents, "EUR")}</span>
    </li>
  );
}
```

## ` web/src/hooks/useInvoices.ts:3-8 `

- Language: typescript
- ` InvoiceDto `, interface, lines 3-8: relevance 0.95

```typescript
export interface InvoiceDto {
  id: string;
  number: string;
  status: "open" | "paid" | "overdue";
  totalCents: number;
}
```

## ` web/src/lib/format.ts:1-3 `

- Language: typescript
- ` format `, function, lines 1-3: relevance 0.70

```typescript
export function format(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}
```

## ` web/src/styles/invoice.module.css:7-11 `

- Language: css
- ` .row `, style, lines 7-11: relevance 0.70

```css
.row {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
}
```

## Left out

- 20 candidate(s) scored below the relevance minimum and are not listed.
