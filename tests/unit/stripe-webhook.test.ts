import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Stripe from "stripe";

import { evidenceFromRetrievedCheckoutSession, stripeWebhookGateway } from "@/lib/stripe/webhook";

describe("Stripe webhook adapter", () => {
  it("uses Stripe's official constructEvent verification", () => {
    const payload = JSON.stringify({ id: "evt_signed_test", type: "checkout.session.completed", data: { object: { id: "cs_signed_test" } } });
    const secret = "whsec_test_signing_secret";
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const gateway = stripeWebhookGateway("sk_test_unused");

    assert.equal(gateway.constructEvent(payload, signature, secret).id, "evt_signed_test");
    assert.throws(() => gateway.constructEvent(`${payload} `, signature, secret));
  });

  it("builds paid evidence only from an expanded Session and its charge", () => {
    const evidence = evidenceFromRetrievedCheckoutSession({
      id: "cs_evidence_test",
      status: "complete",
      payment_status: "paid",
      amount_total: 4_000,
      currency: "usd",
      metadata: { paymentId: "payment_test", appointmentId: "appointment_test" },
      payment_intent: { id: "pi_evidence_test", latest_charge: { created: 1_800_000_000, amount_refunded: 0 } },
    } as unknown as Stripe.Checkout.Session, "evt_evidence_test");

    assert.equal(evidence.charge?.amountCents, 4_000);
    assert.equal(evidence.charge?.paymentIntentId, "pi_evidence_test");
    assert.equal(evidence.reference?.appointmentId, "appointment_test");
  });
});
