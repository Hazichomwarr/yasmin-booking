import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelAppointment, isBookingError } from "@/lib/booking";
import { startAuthorizedBookingCheckout, startBookingDepositCheckout, type CheckoutClock, type CheckoutStartResult } from "@/lib/booking/checkout";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { verifiedCheckoutEvidence } from "@/lib/booking/payment-policy";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { WEEK, createCustomer, createLocation, insertAppointment } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

/**
 * YASMIN-1F.4 refinement of Checkout outcomes: distinct codes and ambiguity
 * reasons for the HTTP boundary, with payment semantics unchanged (one
 * Payment per booking; no replacement Session for any ambiguous outcome).
 */

type RecordedSession = { status?: string; amountCents?: number };

function stripe(mode: { create?: "ok" | "throw"; retrieve?: "throw" | RecordedSession } = {}) {
  let creates = 0;
  let retrieves = 0;
  const idempotencyKeys: string[] = [];
  const created = new Map<string, Awaited<ReturnType<StripeCheckoutAdapter["createDepositCheckout"]>>>();
  const adapter: StripeCheckoutAdapter = {
    async createDepositCheckout(input) {
      creates += 1;
      idempotencyKeys.push(`yasmin-booking-deposit:${input.paymentId}`);
      if (mode.create === "throw") throw new Error("simulated timeout");
      const session = {
        id: `cs_outcome_${input.paymentId}`,
        url: `https://checkout.stripe.com/c/pay/outcome_${creates}`,
        amountCents: input.amountCents,
        currency: input.currency,
        mode: "payment",
        status: "open",
        expiresAt: input.expiresAt,
        metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
      };
      created.set(session.id, session);
      return session;
    },
    async retrieveDepositCheckout(sessionId) {
      retrieves += 1;
      if (mode.retrieve === undefined || mode.retrieve === "throw") throw new Error("simulated outage");
      const session = created.get(sessionId) ?? [...created.values()][0];
      return { ...session, id: sessionId, status: mode.retrieve.status ?? session.status, amountCents: mode.retrieve.amountCents ?? session.amountCents };
    },
  };
  return { adapter, creates: () => creates, retrieves: () => retrieves, idempotencyKeys, mode };
}

const reasonOf = (result: CheckoutStartResult) =>
  result.kind === "ambiguous" ? { reason: result.reason, retryable: result.retryable } : { kind: result.kind };

async function depositOf(appointmentId: string) {
  return prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId, purpose: "BOOKING_DEPOSIT" } } });
}

function evidenceFor(payment: { id: string; amountCents: number }, appointmentId: string, sessionId: string, paid: boolean) {
  return verifiedCheckoutEvidence({
    checkoutSessionId: sessionId,
    sessionStatus: paid ? "complete" : "expired",
    paymentStatus: paid ? "paid" : "unpaid",
    paymentIntentId: paid ? `pi_outcome_${payment.id}` : null,
    amountCents: payment.amountCents,
    currency: "usd",
    paidAt: paid ? new Date() : null,
    metadataPaymentId: payment.id,
    metadataAppointmentId: appointmentId,
  });
}

async function publicBooking() {
  const { location, slot } = await createLocation();
  return createPublicBooking({
    name: "Outcome Customer",
    email: "outcome@example.test",
    phone: "+1 555 010 0100",
    locationId: location.id,
    bookingSlotId: slot.id,
    appointmentDate: WEEK.tuesday,
  });
}

const fixedClock = (now: Date): CheckoutClock => ({ now: async () => new Date(now) });

describe("Checkout outcome refinement", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("returns the access expiry with the public booking result", async () => {
    const created = await publicBooking();
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId } });
    assert.deepEqual(created.accessExpiresAt, stored.accessTokenExpiresAt);
    assert.equal(created.accessExpiresAt.getTime() - stored.accessTokenIssuedAt!.getTime(), 24 * 3600_000);
  });

  it("distinguishes an expired hold from one with too little time left", async () => {
    const { slot } = await createLocation();
    const customer = await createCustomer();
    const now = new Date("2027-03-01T15:00:00.000Z");
    const short = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 59_000) });
    const expired = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: now });
    const s = stripe();

    await assert.rejects(startBookingDepositCheckout(short.id, s.adapter, fixedClock(now)), (e) => isBookingError(e, "HOLD_TIME_INSUFFICIENT"));
    await assert.rejects(startBookingDepositCheckout(expired.id, s.adapter, fixedClock(now)), (e) => isBookingError(e, "HOLD_EXPIRED"));
    assert.equal(await prisma.payment.count(), 0);
    assert.equal(s.creates(), 0);
  });

  it("distinguishes a not-payable booking from an already confirmed one", async () => {
    const cancelled = await publicBooking();
    await cancelAppointment(cancelled.booking.appointmentId);
    await assert.rejects(startAuthorizedBookingCheckout(cancelled.accessToken, { adapter: stripe().adapter }), (e) => isBookingError(e, "BOOKING_NOT_PAYABLE"));

    const paid = await publicBooking();
    const s = stripe();
    assert.equal((await startAuthorizedBookingCheckout(paid.accessToken, { adapter: s.adapter })).kind, "ready");
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: paid.booking.appointmentId } });
    await applyVerifiedCheckoutSession(verifiedCheckoutEvidence({
      checkoutSessionId: payment.providerCheckoutSessionId!,
      sessionStatus: "complete",
      paymentStatus: "paid",
      paymentIntentId: `pi_outcome_${payment.id}`,
      amountCents: payment.amountCents,
      currency: "usd",
      paidAt: new Date(),
      metadataPaymentId: payment.id,
      metadataAppointmentId: paid.booking.appointmentId,
    }));
    await assert.rejects(startAuthorizedBookingCheckout(paid.accessToken, { adapter: s.adapter }), (e) => isBookingError(e, "BOOKING_ALREADY_CONFIRMED"));
    assert.equal(await prisma.payment.count({ where: { appointmentId: paid.booking.appointmentId } }), 1);
    assert.equal(s.creates(), 1);
  });

  it("classifies an uncertain creation identically on the first attempt, an immediate retry and a retry after five minutes", async () => {
    const created = await publicBooking();
    const s = stripe({ create: "throw" });
    const expected = { reason: "checkout-creation-unconfirmed", retryable: false };

    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })), expected, "first attempt");
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })), expected, "immediate retry");
    await prisma.$executeRaw`
      UPDATE "Payment" SET "createdAt" = "createdAt" - interval '5 minutes 1 second'
      WHERE "appointmentId" = ${created.booking.appointmentId}
    `;
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })), expected, "after five minutes");

    // The one Payment and its idempotency key are preserved; Stripe is never asked again.
    const payment = await depositOf(created.booking.appointmentId);
    assert.equal(s.creates(), 1);
    assert.deepEqual(s.idempotencyKeys, [`yasmin-booking-deposit:${payment.id}`]);
    assert.equal(await prisma.payment.count({ where: { appointmentId: created.booking.appointmentId } }), 1);
    assert.deepEqual([payment.status, payment.providerCheckoutSessionId], ["PENDING", null]);
    assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: created.booking.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }), 1);
  });

  it("treats a concurrent request during an in-flight creation as uncertain, then returns the recorded Session", async () => {
    const created = await publicBooking();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const reachedCreate = new Promise<void>((resolve) => (reached = resolve));
    const s = stripe({ retrieve: { status: "open" } });
    const slow: StripeCheckoutAdapter = {
      ...s.adapter,
      async createDepositCheckout(input) {
        reached();
        await released;
        return s.adapter.createDepositCheckout(input);
      },
    };

    const first = startAuthorizedBookingCheckout(created.accessToken, { adapter: slow });
    await reachedCreate;
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })), { reason: "checkout-creation-unconfirmed", retryable: false });
    release();
    assert.equal((await first).kind, "ready");
    assert.equal((await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })).kind, "ready");
    assert.equal(s.creates(), 1);
  });

  it("moves an uncertain creation to attempt-ended only on verified expiry evidence", async () => {
    const created = await publicBooking();
    const s = stripe({ create: "throw" });
    await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter });
    const payment = await depositOf(created.booking.appointmentId);

    const outcome = await applyVerifiedCheckoutSession(evidenceFor(payment, created.booking.appointmentId, `cs_outcome_${payment.id}`, false));
    assert.equal(outcome.kind, "not-paid");
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })), { reason: "checkout-attempt-ended", retryable: false });
    assert.equal(s.creates(), 1);
  });

  it("moves an uncertain creation to confirmed on verified payment evidence", async () => {
    const created = await publicBooking();
    const s = stripe({ create: "throw" });
    await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter });
    const payment = await depositOf(created.booking.appointmentId);

    assert.equal((await applyVerifiedCheckoutSession(evidenceFor(payment, created.booking.appointmentId, `cs_outcome_${payment.id}`, true))).kind, "confirmed");
    await assert.rejects(startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter }), (e) => isBookingError(e, "BOOKING_ALREADY_CONFIRMED"));
    assert.equal(s.creates(), 1);
  });

  it("classifies a recorded Session by Stripe's view of it", async () => {
    const cases: [RecordedSession | "throw", { reason: string; retryable: boolean } | { kind: string }][] = [
      ["throw", { reason: "provider-retrieval-failed", retryable: true }],
      [{ status: "open" }, { kind: "ready" }],
      [{ status: "complete" }, { reason: "payment-awaiting-confirmation", retryable: false }],
      [{ status: "expired" }, { reason: "provider-session-unusable", retryable: false }],
      [{ status: "unknown" }, { reason: "provider-session-unusable", retryable: false }],
      [{ status: "open", amountCents: 1 }, { reason: "provider-session-unusable", retryable: false }],
    ];
    for (const [retrieve, expected] of cases) {
      const created = await publicBooking();
      const s = stripe({ retrieve });
      assert.equal((await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter })).kind, "ready");
      const first = await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter });
      const second = await startAuthorizedBookingCheckout(created.accessToken, { adapter: s.adapter });
      assert.deepEqual(reasonOf(first), expected, JSON.stringify(retrieve));
      assert.deepEqual(reasonOf(second), expected, `${JSON.stringify(retrieve)} repeated`);
      assert.equal(s.creates(), 1);
    }
  });

  it("recognizes a received charge and an ended attempt without calling Stripe", async () => {
    const received = await publicBooking();
    const s = stripe({ retrieve: { status: "open" } });
    await startAuthorizedBookingCheckout(received.accessToken, { adapter: s.adapter });
    const payment = await depositOf(received.booking.appointmentId);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PAID", paidAt: new Date(), providerPaymentIntentId: `pi_received_${payment.id}`, reconciliationReason: "PLACE_UNAVAILABLE" },
    });
    const retrievesBefore = s.retrieves();
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(received.accessToken, { adapter: s.adapter })), { reason: "payment-already-received", retryable: false });

    const ended = await publicBooking();
    await startAuthorizedBookingCheckout(ended.accessToken, { adapter: s.adapter });
    await prisma.payment.update({ where: { id: (await depositOf(ended.booking.appointmentId)).id }, data: { status: "EXPIRED" } });
    assert.deepEqual(reasonOf(await startAuthorizedBookingCheckout(ended.accessToken, { adapter: s.adapter })), { reason: "checkout-attempt-ended", retryable: false });
    assert.equal(s.retrieves(), retrievesBefore);
  });
});
