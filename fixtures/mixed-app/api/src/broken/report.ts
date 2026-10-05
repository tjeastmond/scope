// Deliberately broken: this file is truncated in the middle of a function and has a syntax error.
import type { Billing } from "../models/invoice";

export function summarize(invoices: Billing.Invoice[]): number {
  return invoices.length;
}

export function renderReport(invoices: Billing.Invoice[]): string {
  const lines = invoices.map((invoice) => {
    return `${invoice.number}: ${invoice.totalCents
