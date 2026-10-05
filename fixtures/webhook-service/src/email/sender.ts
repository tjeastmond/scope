import { logger } from "../logger";
import { format } from "./format";

export async function sendWithRetry(to: string, template: string, values: Record<string, string>): Promise<void> {
  const body = format(template, values);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await deliver(to, body);
      return;
    } catch (error) {
      logger.warn(`Email to ${to} failed on attempt ${attempt}`, error);
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw new Error(`Could not deliver email to ${to}`);
}

async function deliver(to: string, body: string): Promise<void> {
  const response = await fetch("https://mail.internal/send", {
    method: "POST",
    body: JSON.stringify({ to, body }),
  });
  if (!response.ok) {
    throw new Error(`Mail service returned ${response.status}`);
  }
}
