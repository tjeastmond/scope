import type { Billing } from "../models/invoice";

export function validate(input: Billing.InvoiceInput): string[] {
  const problems: string[] = [];
  if (!input.number.startsWith("INV-")) problems.push("number must start with INV-");
  if (!input.customerId) problems.push("customerId is required");
  if (input.totalCents <= 0) problems.push("total must be positive");
  return problems;
}
