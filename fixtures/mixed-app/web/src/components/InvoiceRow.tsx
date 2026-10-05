import styles from "../styles/invoice.module.css";
import { format } from "../lib/format";
import type { InvoiceDto } from "../hooks/useInvoices";

export function InvoiceRow({ invoice }: { invoice: InvoiceDto }) {
  const overdue = invoice.status === "overdue";
  return (
    <li className={overdue ? styles.overdue : styles.row}>
      <span>{invoice.number}</span>
      <span>{format(invoice.totalCents, "EUR")}</span>
    </li>
  );
}
