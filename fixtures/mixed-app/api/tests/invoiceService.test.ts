import { describe, expect, test } from "bun:test";
import { InvoiceService } from "../src/services/invoiceService";
import { validate } from "../src/util/validate";

describe("InvoiceService", () => {
  test("creates open invoices", async () => {
    const service = new InvoiceService();
    const invoice = await service.create({ number: "INV-0001", customerId: "c1", totalCents: 1000 });
    expect(invoice.status).toBe("open");
  });

  test("marks invoices paid", async () => {
    const service = new InvoiceService();
    const { id } = await service.create({ number: "INV-0002", customerId: "c1", totalCents: 500 });
    expect((await service.markPaid(id))?.status).toBe("paid");
  });
});

test("validate rejects a missing customer", () => {
  expect(validate({ number: "INV-0003", customerId: "", totalCents: 100 })).toContain("customerId is required");
});
