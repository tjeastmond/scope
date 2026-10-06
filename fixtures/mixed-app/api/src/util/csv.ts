// This file is checked in with CRLF line endings on purpose.
import type { Billing } from "../models/invoice";

export function escapeCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(invoices: Billing.Invoice[]): string {
  const header = "id,number,total_cents,status";
  const rows = invoices.map((invoice) =>
    [invoice.id, invoice.number, String(invoice.totalCents), invoice.status].map(escapeCell).join(","),
  );
  return [header, ...rows].join("\r\n");
}
