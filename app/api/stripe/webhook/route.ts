import { after } from "next/server";

import { deliverConfirmationEmailsAfterWebhook } from "@/lib/email/cron-api";
import { stripeWebhookApi } from "@/lib/http/stripe-webhook-api";

export const runtime = "nodejs";

/** Signed server-to-server Stripe delivery endpoint. No browser auth or CSRF guard applies. */
export async function POST(request: Request): Promise<Response> {
  const response = await stripeWebhookApi(request);
  // Prompt confirmation email after an acknowledged delivery: post-response,
  // outside every payment transaction, never changing Stripe's answer.
  if (response.status === 200) after(() => deliverConfirmationEmailsAfterWebhook());
  return response;
}
