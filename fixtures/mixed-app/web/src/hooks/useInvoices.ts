import { useEffect, useState } from "react";

export interface InvoiceDto {
  id: string;
  number: string;
  status: "open" | "paid" | "overdue";
  totalCents: number;
}

export function useInvoices(status: InvoiceDto["status"]) {
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    fetch(`/invoices?status=${status}`)
      .then((response) => response.json())
      .then(setInvoices)
      .catch((cause) => setError(String(cause)))
      .finally(() => setLoading(false));
  }, [status]);

  return { invoices, loading, error };
}
