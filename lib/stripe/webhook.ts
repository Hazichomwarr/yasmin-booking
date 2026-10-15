import type Stripe from "stripe";

import { verifiedCheckoutEvidence, type CheckoutEvidenceInput } from "@/lib/booking/payment-policy";

import { stripeClient } from "./client";

/** The only Checkout events this application needs for payment fulfillment. */
export const STRIPE_CHECKOUT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

export type StripeWebhookGateway = {
  constructEvent(payload: string, signature: string, webhookSecret: string): Stripe.Event;
  retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session>;
};

export function stripeWebhookGateway(secretKey: string): StripeWebhookGateway {
  const stripe = stripeClient(secretKey);
  return {
    constructEvent(payload, signature, webhookSecret) {
      return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    },
    async retrieveCheckoutSession(sessionId) {
      return stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent.latest_charge"],
      });
    },
  };
}

/**
 * Converts a freshly retrieved Stripe Session into the fulfillment module's
 * branded evidence. The signed Event supplies identity only; every money fact
 * is read from Stripe's API response.
 */
export function evidenceFromRetrievedCheckoutSession(
  session: Stripe.Checkout.Session,
  stripeEventId: string,
) {
  const paymentIntent = typeof session.payment_intent === "object" && session.payment_intent !== null
    ? session.payment_intent
    : null;
  const charge = paymentIntent && typeof paymentIntent.latest_charge === "object" && paymentIntent.latest_charge !== null
    ? paymentIntent.latest_charge
    : null;

  const input: CheckoutEvidenceInput = {
    checkoutSessionId: session.id,
    sessionStatus: session.status ?? "unknown",
    paymentStatus: session.payment_status ?? "unknown",
    metadataPaymentId: session.metadata?.paymentId ?? null,
    metadataAppointmentId: session.metadata?.appointmentId ?? null,
    stripeEventId,
  };

  if (session.payment_status === "paid") {
    input.paymentIntentId = paymentIntent?.id ?? null;
    input.amountCents = session.amount_total ?? null;
    input.currency = session.currency ?? null;
    input.paidAt = charge ? new Date(charge.created * 1_000) : null;
    input.refundedOrPendingCents = charge?.amount_refunded ?? 0;
  }

  return verifiedCheckoutEvidence(input);
}
