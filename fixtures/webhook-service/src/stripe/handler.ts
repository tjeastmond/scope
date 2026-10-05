import { logger } from "../logger";
import { verifySignature } from "../webhooks/signature";
import type { StripeEvent, WebhookResult } from "./types";

const seenEvents = new Set<string>();

export async function handleStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<WebhookResult> {
  if (!verifySignature(rawBody, signatureHeader, secret)) {
    logger.warn("Rejected Stripe webhook with invalid signature");
    return { status: "rejected", reason: "invalid signature" };
  }

  const event = JSON.parse(rawBody) as StripeEvent;
  if (seenEvents.has(event.id)) {
    return { status: "processed", eventId: event.id };
  }

  await processEvent(event);
  seenEvents.add(event.id);
  return { status: "processed", eventId: event.id };
}

export async function processEvent(event: StripeEvent): Promise<void> {
  switch (event.type) {
    case "invoice.payment_succeeded":
      await markInvoicePaid(String(event.data.object.id));
      break;
    case "customer.subscription.deleted":
      await cancelSubscription(String(event.data.object.id));
      break;
    default:
      logger.info(`Ignoring Stripe event type ${event.type}`);
  }
}

const markInvoicePaid = async (invoiceId: string): Promise<void> => {
  const response = await fetch(`https://billing.internal/invoices/${invoiceId}/paid`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Billing service returned ${response.status}`);
  }
};

const cancelSubscription = async (subscriptionId: string): Promise<void> => {
  const response = await fetch(`https://billing.internal/subscriptions/${subscriptionId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Billing service returned ${response.status}`);
  }
};
