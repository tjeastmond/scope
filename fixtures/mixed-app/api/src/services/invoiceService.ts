import type { Billing } from "../models/invoice";

export class InvoiceService {
  private readonly store = new Map<string, Billing.Invoice>();
  private sequence = 0;

  async create(input: Billing.InvoiceInput): Promise<Billing.Invoice> {
    const id = `inv_${++this.sequence}`;
    const invoice: Billing.Invoice = { ...input, id, status: "open", dueDate: this.dueDateFrom(new Date()) };
    this.store.set(id, invoice);
    return invoice;
  }

  async listByStatus(status: Billing.Status): Promise<Billing.Invoice[]> {
    return [...this.store.values()].filter((invoice) => invoice.status === status);
  }

  async markPaid(id: string): Promise<Billing.Invoice | undefined> {
    const invoice = this.store.get(id);
    if (!invoice) return undefined;
    invoice.status = "paid";
    return invoice;
  }

  private dueDateFrom(start: Date): string {
    const due = new Date(start);
    due.setDate(due.getDate() + 30);
    return due.toISOString().slice(0, 10);
  }
}
