import { createServer } from "node:http";
import { handleHealth } from "./routes/health";
import { handleInvoices } from "./routes/invoices";

export function route(url: string): ((req: unknown, res: unknown) => Promise<void>) | undefined {
  if (url.startsWith("/invoices")) return handleInvoices;
  if (url === "/health") return handleHealth;
  return undefined;
}

export function start(port = 4000) {
  const server = createServer(async (req, res) => {
    const handler = route(req.url ?? "/");
    if (!handler) {
      res.statusCode = 404;
      res.end();
      return;
    }
    await handler(req, res);
  });
  return server.listen(port);
}
