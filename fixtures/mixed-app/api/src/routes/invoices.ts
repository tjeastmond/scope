import { InvoiceService } from "../services/invoiceService";
import { validate } from "../util/validate";
import { format } from "../util/format";
import { Billing } from "../models/invoice";

const service = new InvoiceService();

interface Response {
  statusCode: number;
  end(body: string): void;
}

export async function listInvoices(status: Billing.Status, res: Response): Promise<void> {
  const invoices = await service.listByStatus(status);
  res.end(JSON.stringify(invoices.map((invoice) => ({ ...invoice, total: format(invoice.totalCents) }))));
}

export async function createInvoice(body: Billing.InvoiceInput, res: Response): Promise<void> {
  const problems = validate(body);
  if (problems.length > 0) {
    res.statusCode = 422;
    res.end(JSON.stringify({ problems }));
    return;
  }
  res.statusCode = 201;
  res.end(JSON.stringify(await service.create(body)));
}

export async function handleInvoices(req: unknown, res: unknown): Promise<void> {
  const request = req as { method: string; body?: Billing.InvoiceInput; query?: { status?: Billing.Status } };
  if (request.method === "POST" && request.body) return createInvoice(request.body, res as Response);
  return listInvoices(request.query?.status ?? "open", res as Response);
}
