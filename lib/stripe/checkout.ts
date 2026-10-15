import type Stripe from "stripe";

import { stripeClient } from "./client";

export type CreateDepositCheckoutInput = {
  paymentId: string;
  appointmentId: string;
  amountCents: number;
  currency: "usd";
  expiresAt: Date;
};

export type CreatedCheckoutSession = {
  id: string;
  url: string;
  amountCents: number;
  currency: string;
  mode: string;
  /** Stripe Checkout Session lifecycle state; required for reuse decisions. */
  status: string;
  expiresAt: Date;
  metadata: { paymentId?: string; appointmentId?: string };
};

export interface StripeCheckoutAdapter {
  createDepositCheckout(input: CreateDepositCheckoutInput): Promise<CreatedCheckoutSession>;
  retrieveDepositCheckout(sessionId: string): Promise<CreatedCheckoutSession>;
  /** Internal test synchronization point; production adapters leave this absent. */
  afterCreateBeforePersistence?(session: CreatedCheckoutSession, input: CreateDepositCheckoutInput): Promise<void>;
}

function configuration() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_BASE_URL;
  if (!secretKey || !baseUrl) throw new Error("Stripe checkout requires STRIPE_SECRET_KEY and APP_BASE_URL.");
  return { secretKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

type StripeCheckoutClient = Pick<Stripe, "checkout">;

export function stripeCheckoutAdapter(): StripeCheckoutAdapter {
  const { secretKey, baseUrl } = configuration();
  return createStripeCheckoutAdapter(stripeClient(secretKey), baseUrl);
}

/** Exported for deterministic adapter tests; application code uses the factory above. */
export function createStripeCheckoutAdapter(
  stripe: StripeCheckoutClient,
  baseUrl: string,
): StripeCheckoutAdapter {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  function checkoutSession(session: Stripe.Checkout.Session): CreatedCheckoutSession {
    if (!session.id || !session.url) {
      throw new Error("Stripe returned a Checkout Session without an id or URL.");
    }
    return {
      id: session.id,
      url: session.url,
      amountCents: session.amount_total ?? -1,
      currency: session.currency ?? "",
      mode: session.mode ?? "",
      // A missing provider status is deliberately represented as unknown so
      // recovery remains conservative instead of treating it as reusable.
      status: session.status ?? "unknown",
      expiresAt: new Date(session.expires_at * 1000),
      metadata: {
        paymentId: session.metadata?.paymentId,
        appointmentId: session.metadata?.appointmentId,
      },
    };
  }

  return {
    async createDepositCheckout(input) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          payment_method_types: ["card"],
          success_url: `${normalizedBaseUrl}/book/status?return=success`,
          cancel_url: `${normalizedBaseUrl}/book/status?return=cancel`,
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
          metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
          payment_intent_data: { metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId } },
          line_items: [{ quantity: 1, price_data: { currency: input.currency, unit_amount: input.amountCents, product_data: { name: "Yasmin's Beauty Salon booking deposit" } } }],
          adaptive_pricing: { enabled: false },
        },
        { idempotencyKey: `yasmin-booking-deposit:${input.paymentId}` },
      );
      return checkoutSession(session);
    },
    async retrieveDepositCheckout(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return checkoutSession(session);
    },
  };
}
