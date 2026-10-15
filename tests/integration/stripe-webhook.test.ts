import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type Stripe from "stripe";

import { acquireBookingHold, cancelAppointment } from "@/lib/booking";
import { startBookingDepositCheckout } from "@/lib/booking/checkout";
import { processSignedStripeWebhookEvent } from "@/lib/booking/stripe-webhook";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";
import type { StripeWebhookGateway } from "@/lib/stripe/webhook";

import { WEEK, createCustomer, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

async function pendingCheckout() {
  const { slot } = await createLocation();
  const customer = await createCustomer();
  const hold = await acquireBookingHold({ customerId: customer.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.tuesday });
  const adapter: StripeCheckoutAdapter = {
    async createDepositCheckout(input) {
      return {
        id: `cs_webhook_${input.paymentId}`,
        url: "https://checkout.stripe.com/c/pay/webhook",
        amountCents: input.amountCents,
        currency: "usd",
        mode: "payment",
        status: "open",
        expiresAt: input.expiresAt,
        metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
      };
    },
    async retrieveDepositCheckout() { throw new Error("not used"); },
  };
  const started = await startBookingDepositCheckout(hold.appointmentId, adapter);
  assert.equal(started.kind, "ready");
  const payment = await prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } });
  return { hold, payment };
}

function gateway(payment: { id: string; appointmentId: string; amountCents: number; providerCheckoutSessionId: string | null }, options: { amountCents?: number; currency?: string; status?: "complete" | "expired"; paymentStatus?: "paid" | "unpaid" } = {}): StripeWebhookGateway {
  const status = options.status ?? "complete";
  const paymentStatus = options.paymentStatus ?? "paid";
  return {
    constructEvent() { throw new Error("not used"); },
    async retrieveCheckoutSession(sessionId) {
      return {
        id: sessionId,
        status,
        payment_status: paymentStatus,
        amount_total: options.amountCents ?? payment.amountCents,
        currency: options.currency ?? "usd",
        metadata: { paymentId: payment.id, appointmentId: payment.appointmentId },
        payment_intent: paymentStatus === "paid" ? {
          id: `pi_webhook_${payment.id}`,
          latest_charge: { created: Math.floor(Date.now() / 1_000), amount_refunded: 0 },
        } : null,
      } as unknown as Stripe.Checkout.Session;
    },
  };
}

const event = (id: string, sessionId: string, type = "checkout.session.completed") => ({ id, type, data: { object: { id: sessionId } } });

describe("signed Stripe webhook event processing", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("confirms a verified $40 deposit once and durably records the delivery", async () => {
    const { hold, payment } = await pendingCheckout();
    const result = await processSignedStripeWebhookEvent(event("evt_webhook_paid", payment.providerCheckoutSessionId!), gateway(payment));
    assert.deepEqual(result, { kind: "processed" });
    const [appointment, after, receipt, events] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: "evt_webhook_paid" } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: hold.appointmentId } }),
    ]);
    assert.equal(appointment.status, "CONFIRMED");
    assert.equal(after.status, "PAID");
    assert.equal(after.amountCents, 4_000);
    assert.ok(after.allocatedAt);
    assert.equal(receipt.state, "PROCESSED");
    assert.equal(events.filter((row) => row.type === "PAYMENT_CONFIRMED").length, 1);
  });

  it("acknowledges duplicate and concurrent deliveries without duplicate effects", async () => {
    const { hold, payment } = await pendingCheckout();
    const signed = event("evt_webhook_duplicate", payment.providerCheckoutSessionId!);
    const outcomes = await Promise.all([
      processSignedStripeWebhookEvent(signed, gateway(payment)),
      processSignedStripeWebhookEvent(signed, gateway(payment)),
    ]);
    assert.ok(outcomes.some((outcome) => outcome.kind === "processed"));
    assert.ok(outcomes.every((outcome) => ["processed", "duplicate", "busy"].includes(outcome.kind)));
    const retry = await processSignedStripeWebhookEvent(signed, gateway(payment));
    assert.equal(retry.kind, "duplicate");
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 1);
    assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "PAYMENT_CONFIRMED" } }), 1);
  });

  it("fences a stale fulfillment worker after a newer lease completes", async () => {
    const { hold, payment } = await pendingCheckout();
    const signed = event("evt_webhook_stale_fulfillment", payment.providerCheckoutSessionId!);
    let releaseWorkerA!: () => void;
    let signalClaimed!: () => void;
    const workerAReleased = new Promise<void>((resolve) => { releaseWorkerA = resolve; });
    const workerAClaimed = new Promise<void>((resolve) => { signalClaimed = resolve; });

    const workerA = processSignedStripeWebhookEvent(signed, gateway(payment), {
      async afterClaimed() {
        signalClaimed();
        await workerAReleased;
      },
    });

    await workerAClaimed;
    await prisma.stripeWebhookEvent.update({
      where: { id: signed.id },
      data: { processingStartedAt: new Date(Date.now() - 6 * 60_000) },
    });

    const workerB = await processSignedStripeWebhookEvent(signed, gateway(payment));
    assert.deepEqual(workerB, { kind: "processed" });
    releaseWorkerA();
    assert.deepEqual(await workerA, { kind: "duplicate" });

    const [receipt, appointment, after, confirmedEvents] = await Promise.all([
      prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: signed.id } }),
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "PAYMENT_CONFIRMED" } }),
    ]);
    assert.equal(receipt.state, "PROCESSED");
    assert.equal(receipt.leaseToken, null);
    assert.equal(receipt.attemptCount, 2);
    assert.equal(appointment.status, "CONFIRMED");
    assert.equal(after.status, "PAID");
    assert.ok(after.allocatedAt);
    assert.equal(confirmedEvents, 1);
  });

  it("records a durable reconciliation case for an amount conflict and acknowledges it", async () => {
    const { hold, payment } = await pendingCheckout();
    const result = await processSignedStripeWebhookEvent(event("evt_webhook_amount", payment.providerCheckoutSessionId!), gateway(payment, { amountCents: 3_999 }));
    assert.deepEqual(result, { kind: "reconciliation-recorded" });
    const [after, receipt] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: "evt_webhook_amount" } }),
    ]);
    assert.equal(after.status, "PAID");
    assert.equal(after.reconciliationReason, "AMOUNT_MISMATCH");
    assert.equal(receipt.state, "RECONCILIATION_REQUIRED");
    assert.equal(await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }).then((row) => row.status), "PENDING_PAYMENT");
  });

  it("fences a stale reconciliation worker after a newer lease durably records the exception", async () => {
    const { hold, payment } = await pendingCheckout();
    const signed = event("evt_webhook_stale_reconciliation", payment.providerCheckoutSessionId!);
    let releaseWorkerA!: () => void;
    let signalClaimed!: () => void;
    const workerAReleased = new Promise<void>((resolve) => { releaseWorkerA = resolve; });
    const workerAClaimed = new Promise<void>((resolve) => { signalClaimed = resolve; });

    const workerA = processSignedStripeWebhookEvent(signed, gateway(payment, { amountCents: 3_999 }), {
      async afterClaimed() {
        signalClaimed();
        await workerAReleased;
      },
    });

    await workerAClaimed;
    await prisma.stripeWebhookEvent.update({
      where: { id: signed.id },
      data: { processingStartedAt: new Date(Date.now() - 6 * 60_000) },
    });

    const workerB = await processSignedStripeWebhookEvent(signed, gateway(payment, { amountCents: 3_999 }));
    assert.deepEqual(workerB, { kind: "reconciliation-recorded" });
    releaseWorkerA();
    assert.deepEqual(await workerA, { kind: "duplicate" });

    const [receipt, appointment, after, confirmedEvents] = await Promise.all([
      prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: signed.id } }),
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "PAYMENT_CONFIRMED" } }),
    ]);
    assert.equal(receipt.state, "RECONCILIATION_REQUIRED");
    assert.equal(receipt.leaseToken, null);
    assert.equal(receipt.attemptCount, 2);
    assert.equal(appointment.status, "PENDING_PAYMENT");
    assert.equal(after.status, "PAID");
    assert.equal(after.reconciliationReason, "AMOUNT_MISMATCH");
    assert.equal(confirmedEvents, 0);
  });

  it("does not let an expiration delivered after payment reverse confirmation", async () => {
    const { hold, payment } = await pendingCheckout();
    await processSignedStripeWebhookEvent(event("evt_webhook_success", payment.providerCheckoutSessionId!), gateway(payment));
    const result = await processSignedStripeWebhookEvent(
      event("evt_webhook_expired", payment.providerCheckoutSessionId!, "checkout.session.expired"),
      gateway(payment, { status: "expired", paymentStatus: "unpaid" }),
    );
    assert.equal(result.kind, "reconciliation-recorded");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } })).status, "CONFIRMED");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "PAID");
  });

  it("records a paid session for a cancelled booking without reviving it", async () => {
    const { hold, payment } = await pendingCheckout();
    await cancelAppointment(hold.appointmentId);
    const result = await processSignedStripeWebhookEvent(event("evt_webhook_cancelled", payment.providerCheckoutSessionId!), gateway(payment));
    assert.equal(result.kind, "reconciliation-recorded");
    const [appointment, after] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
    ]);
    assert.equal(appointment.status, "CANCELLED");
    assert.equal(after.status, "PAID");
    assert.equal(after.reconciliationReason, "APPOINTMENT_NOT_PAYABLE");
  });

  it("can confirm a valid paid Session after its original hold expired when capacity remains", async () => {
    const { hold, payment } = await pendingCheckout();
    await prisma.appointment.update({ where: { id: hold.appointmentId }, data: { holdExpiresAt: new Date(Date.now() - 1_000) } });
    const result = await processSignedStripeWebhookEvent(event("evt_webhook_expired_hold", payment.providerCheckoutSessionId!), gateway(payment));
    assert.equal(result.kind, "processed");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } })).status, "CONFIRMED");
  });

  it("allows verified success after a prior expired notification without trusting delivery order", async () => {
    const { hold, payment } = await pendingCheckout();
    const expired = await processSignedStripeWebhookEvent(
      event("evt_webhook_first_expired", payment.providerCheckoutSessionId!, "checkout.session.expired"),
      gateway(payment, { status: "expired", paymentStatus: "unpaid" }),
    );
    assert.equal(expired.kind, "processed");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "EXPIRED");
    const success = await processSignedStripeWebhookEvent(event("evt_webhook_late_success", payment.providerCheckoutSessionId!), gateway(payment));
    assert.equal(success.kind, "processed");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } })).status, "CONFIRMED");
  });

  it("ignores unrelated signed Stripe events without a receipt or domain write", async () => {
    const result = await processSignedStripeWebhookEvent(event("evt_webhook_irrelevant", "cs_unused", "customer.created"), {
      constructEvent() { throw new Error("not used"); },
      async retrieveCheckoutSession() { throw new Error("not used"); },
    });
    assert.deepEqual(result, { kind: "ignored" });
    assert.equal(await prisma.stripeWebhookEvent.count(), 0);
  });
});
