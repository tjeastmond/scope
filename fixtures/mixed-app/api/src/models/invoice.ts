export namespace Billing {
  export type Status = "open" | "paid" | "overdue";

  export interface InvoiceInput {
    number: string;
    customerId: string;
    totalCents: number;
  }

  export interface Invoice extends InvoiceInput {
    id: string;
    status: Status;
    dueDate: string;
  }

  export class Ledger {
    private entries: Invoice[] = [];

    add(invoice: Invoice): void {
      this.entries.push(invoice);
    }

    total(): number {
      return this.entries.reduce((sum, entry) => sum + entry.totalCents, 0);
    }
  }
}
