export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export type WebhookResult = { status: "processed"; eventId: string } | { status: "rejected"; reason: string };
