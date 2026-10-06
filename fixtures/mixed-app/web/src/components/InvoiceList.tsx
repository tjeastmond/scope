import styles from "../styles/invoice.module.css";
import { InvoiceRow } from "./InvoiceRow";
import type { InvoiceDto } from "../hooks/useInvoices";

interface InvoiceListProps {
  invoices: InvoiceDto[];
}

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
