import { InvoiceList } from "./components/InvoiceList";
import { Greeting } from "./components/Greeting";
import { useInvoices } from "./hooks/useInvoices";

export function App() {
  const { invoices, loading, error } = useInvoices("open");
  if (error) return <p role="alert">Could not load invoices: {error}</p>;
  return (
    <div>
      <Greeting name="Zoë" />
      {loading ? <p>Loading…</p> : <InvoiceList invoices={invoices} />}
    </div>
  );
}
