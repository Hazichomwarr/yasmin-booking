import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type Stripe from "stripe";

import {
  createStripeCheckoutAdapter,
  type CreateDepositCheckoutInput,
} from "@/lib/stripe/checkout";

const input: CreateDepositCheckoutInput = {
  paymentId: "payment_test_123",
  appointmentId: "appointment_test_456",
  amountCents: 4_000,
  currency: "usd",
  expiresAt: new Date("2026-10-13T15:34:00.000Z"),
};

type Captured = {
  params: Stripe.Checkout.SessionCreateParams;
  options: Stripe.RequestOptions;
};

function session(overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id: "cs_test_123",
    url: "https://checkout.stripe.test/c/pay/cs_test_123",
    amount_total: input.amountCents,
    currency: "usd",
    mode: "payment",
    status: "open",
    expires_at: Math.floor(input.expiresAt.getTime() / 1_000),
    metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function adapterWith(captured: Captured[], response = session()) {
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
          captured.push({ params, options: options! });
          return response;
        },
        retrieve: async () => response,
      },
    },
  } as unknown as Stripe;
  return createStripeCheckoutAdapter(stripe, "https://booking.example.test/");
}

describe("Stripe Checkout adapter", () => {
  it("uses the stored $40 deposit snapshot, USD, payment mode, and card only", async () => {
    const captured: Captured[] = [];
    await adapterWith(captured).createDepositCheckout(input);

    assert.equal(captured.length, 1);
    const [lineItem] = captured[0].params.line_items!;
    assert.equal(lineItem.price_data!.unit_amount, 4_000);
    assert.equal(lineItem.price_data!.currency, "usd");
    assert.equal(captured[0].params.mode, "payment");
    assert.deepEqual(captured[0].params.payment_method_types, ["card"]);
  });

  it("uses fixed expiration, server metadata, and deterministic URLs", async () => {
    const captured: Captured[] = [];
    await adapterWith(captured).createDepositCheckout(input);
    const { params } = captured[0];

    assert.equal(params.expires_at, 1_791_905_640);
    assert.deepEqual(params.metadata, {
      paymentId: input.paymentId,
      appointmentId: input.appointmentId,
    });
    assert.deepEqual(params.payment_intent_data?.metadata, params.metadata);
    assert.equal(
      params.success_url,
      "https://booking.example.test/book/success?appointment_id=appointment_test_456",
    );
    assert.equal(
      params.cancel_url,
      "https://booking.example.test/book/cancel?appointment_id=appointment_test_456",
    );
    assert.equal("customer_email" in params, false);
  });

  it("replays exactly the same Stripe request and stable idempotency key", async () => {
    const captured: Captured[] = [];
    const adapter = adapterWith(captured);
    await adapter.createDepositCheckout(input);
    await adapter.createDepositCheckout(input);

    assert.deepEqual(captured[1].params, captured[0].params);
    assert.equal(captured[0].options.idempotencyKey, "yasmin-booking-deposit:payment_test_123");
    assert.equal(captured[1].options.idempotencyKey, captured[0].options.idempotencyKey);
  });

  it("rejects a malformed Stripe response before a caller can persist it", async () => {
    const captured: Captured[] = [];
    await assert.rejects(
      adapterWith(captured, session({ url: null })).createDepositCheckout(input),
      /without an id or URL/,
    );
  });

  it("preserves provider status and conservatively labels an omitted status unknown", async () => {
    const captured: Captured[] = [];
    const open = await adapterWith(captured, session({ status: "open" })).retrieveDepositCheckout("cs_test_123");
    const unknown = await adapterWith(captured, session({ status: null })).retrieveDepositCheckout("cs_test_123");

    assert.equal(open.status, "open");
    assert.equal(unknown.status, "unknown");
  });
});
