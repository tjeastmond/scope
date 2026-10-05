import { handleStripeWebhook } from "../src/stripe/handler";

function expectStatus(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Expected ${expected} but got ${actual}`);
  }
}

export async function checkRejectsInvalidSignature(): Promise<void> {
  const result = await handleStripeWebhook('{"id":"evt_1","type":"ping"}', "t=1,v1=bad", "whsec_test");
  expectStatus(result.status, "rejected");
}
