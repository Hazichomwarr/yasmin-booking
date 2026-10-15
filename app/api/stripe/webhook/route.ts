import { stripeWebhookApi } from "@/lib/http/stripe-webhook-api";

export const runtime = "nodejs";

/** Signed server-to-server Stripe delivery endpoint. No browser auth or CSRF guard applies. */
export const POST = stripeWebhookApi;
