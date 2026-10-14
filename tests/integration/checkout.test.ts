import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acquireBookingHold } from "@/lib/booking";
import { cancelAppointment } from "@/lib/booking";
import { startAuthorizedBookingCheckout, startBookingDepositCheckout, type CheckoutClock } from "@/lib/booking/checkout";
import { issueBookingAccess, revokeBookingAccess } from "@/lib/booking/access";
import { BookingAccessError } from "@/lib/booking/errors";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { verifiedCheckoutEvidence } from "@/lib/booking/payment-policy";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { WEEK, createCustomer, createLocation, insertAppointment } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

function stripeDouble(mode: "success" | "timeout" = "success") {
  let calls = 0;
  const adapter: StripeCheckoutAdapter = {
    async createDepositCheckout(input) {
      calls += 1;
      if (mode === "timeout") throw new Error("simulated timeout");
      return {
        id: `cs_checkout_${input.paymentId}`,
        url: `https://checkout.example.test/${input.paymentId}`,
        amountCents: input.amountCents,
        currency: input.currency,
        mode: "payment",
        expiresAt: input.expiresAt,
        metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
      };
    },
    async retrieveDepositCheckout() {
      throw new Error("not used by this test double");
    },
  };
  return { adapter, calls: () => calls };
}

async function heldAppointment() {
  const { slot } = await createLocation();
  const customer = await createCustomer();
  return acquireBookingHold({
    customerId: customer.id,
    locationId: slot.locationId,
    bookingSlotId: slot.id,
    appointmentDate: WEEK.tuesday,
  });
}

async function withDatabaseFault(triggerSql: string, work: () => Promise<void>) {
  await prisma.$executeRawUnsafe("CREATE OR REPLACE FUNCTION checkout_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'checkout test fault'; END; $$");
  await prisma.$executeRawUnsafe(triggerSql);
  try {
    await work();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS checkout_test_fault_trigger ON "Payment"');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS checkout_test_fault_trigger ON "Appointment"');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS checkout_test_fault_trigger ON "AppointmentEvent"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS checkout_test_fault()');
  }
}

async function checkoutSnapshot(appointmentId: string) {
  const [appointment, payments, events] = await Promise.all([
    prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    prisma.payment.findMany({ where: { appointmentId } }),
    prisma.appointmentEvent.findMany({ where: { appointmentId }, orderBy: { createdAt: "asc" } }),
  ]);
  return { appointment, payments, events };
}

const fixedClock = (now: Date): CheckoutClock => ({ now: async () => new Date(now) });
const sequenceClock = (...times: Date[]): CheckoutClock => ({ now: async () => new Date(times[Math.min(times.length - 1, sequenceClockIndex++)]) });
let sequenceClockIndex = 0;

describe("checkout initiation", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("creates one payment, extends the hold once, and writes its atomic audit event", async () => {
    const hold = await heldAppointment();
    const before = hold.holdExpiresAt;
    const stripe = stripeDouble();
    const result = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;

    const [payment, appointment, events] = await Promise.all([
      prisma.payment.findMany({ where: { appointmentId: hold.appointmentId } }),
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: hold.appointmentId }, orderBy: { createdAt: "asc" } }),
    ]);
    assert.equal(payment.length, 1);
    assert.equal(payment[0].amountCents, 4_000);
    assert.equal(payment[0].providerCheckoutSessionId, `cs_checkout_${payment[0].id}`);
    assert.equal(payment[0].providerCheckoutExpiresAt?.getTime(), result.expiresAt.getTime());
    assert.ok(appointment.holdExpiresAt!.getTime() > before.getTime());
    assert.deepEqual(events.map((event) => event.type), ["CREATED", "HOLD_EXPIRY_CHANGED"]);
    assert.equal(stripe.calls(), 1);
  });

  it("does not add another payment or extend the hold after an ambiguous timeout", async () => {
    const hold = await heldAppointment();
    const stripe = stripeDouble("timeout");
    const result = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
    assert.equal(result.kind, "ambiguous");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
    assert.equal(payment.providerCheckoutSessionId, null);
    assert.ok(appointment.holdExpiresAt!.getTime() > hold.holdExpiresAt.getTime());

    const retry = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
    assert.equal(retry.kind, "ambiguous");
    assert.equal(stripe.calls(), 1);
  });

  it("treats a network failure as ambiguous without retrying Stripe", async () => {
    const hold = await heldAppointment();
    const stripe = stripeDouble("timeout");
    const result = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
    assert.equal(result.kind, "ambiguous");
    const state = await checkoutSnapshot(hold.appointmentId);
    assert.equal(state.payments.length, 1); assert.equal(state.payments[0].status, "PENDING"); assert.equal(state.events.filter((event) => event.type === "HOLD_EXPIRY_CHANGED").length, 1);
    await startBookingDepositCheckout(hold.appointmentId, stripe.adapter); assert.equal(stripe.calls(), 1);
  });

  it("treats malformed provider facts as ambiguous and never persists a Session", async () => {
    const hold = await heldAppointment(); let calls = 0;
    const adapter: StripeCheckoutAdapter = {
      async createDepositCheckout(input) { calls += 1; return { id: "cs_malformed", url: "https://checkout.example.test/malformed", amountCents: input.amountCents + 1, currency: "usd", mode: "payment", expiresAt: input.expiresAt, metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId } }; },
      async retrieveDepositCheckout() { throw new Error("not used"); },
    };
    const result = await startBookingDepositCheckout(hold.appointmentId, adapter); assert.equal(result.kind, "ambiguous");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } });
    assert.equal(payment.providerCheckoutSessionId, null); assert.equal(payment.status, "PENDING");
    await startBookingDepositCheckout(hold.appointmentId, adapter); assert.equal(calls, 1);
  });

  it("serializes simultaneous initiation: one payment, one extension, one provider creation", async () => {
    const hold = await heldAppointment();
    const stripe = stripeDouble();
    const [first, second] = await Promise.all([
      startBookingDepositCheckout(hold.appointmentId, stripe.adapter),
      startBookingDepositCheckout(hold.appointmentId, stripe.adapter),
    ]);
    const [payments, events] = await Promise.all([
      prisma.payment.findMany({ where: { appointmentId: hold.appointmentId } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: hold.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }),
    ]);
    assert.equal(payments.length, 1);
    assert.equal(events.length, 1);
    assert.equal(stripe.calls(), 1);
    assert.equal([first.kind, second.kind].filter((kind) => kind === "ready").length, 1);
    assert.equal([first.kind, second.kind].filter((kind) => kind === "ambiguous").length, 1);
  });

  it("does not return a Checkout URL when cancellation wins after Stripe creation", async () => {
    const hold = await heldAppointment();
    let release!: () => void;
    let created!: () => void;
    const createdAtProvider = new Promise<void>((resolve) => { created = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const adapter: StripeCheckoutAdapter = {
      async createDepositCheckout(input) {
        created();
        await pause;
        return { id: `cs_cancel_${input.paymentId}`, url: "https://checkout.example.test/cancel", amountCents: input.amountCents, currency: "usd", mode: "payment", expiresAt: input.expiresAt, metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId } };
      },
      async retrieveDepositCheckout() { throw new Error("not used"); },
    };
    const starting = startBookingDepositCheckout(hold.appointmentId, adapter);
    await createdAtProvider;
    await cancelAppointment(hold.appointmentId);
    release();
    const result = await starting;
    assert.equal(result.kind, "ambiguous");
    const [appointment, payment] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } }),
    ]);
    assert.equal(appointment.status, "CANCELLED");
    assert.equal(payment.providerCheckoutSessionId, null);
  });

  it("preserves fulfilled payment facts when fulfillment wins before session persistence", async () => {
    const hold = await heldAppointment();
    const adapter: StripeCheckoutAdapter = {
      async createDepositCheckout(input) {
        return { id: `cs_fulfilled_${input.paymentId}`, url: "https://checkout.example.test/fulfilled", amountCents: input.amountCents, currency: input.currency, mode: "payment", expiresAt: input.expiresAt, metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId } };
      },
      async retrieveDepositCheckout() { throw new Error("not used"); },
      async afterCreateBeforePersistence(session, input) {
        await applyVerifiedCheckoutSession(verifiedCheckoutEvidence({ checkoutSessionId: session.id, sessionStatus: "complete", paymentStatus: "paid", paymentIntentId: `pi_fulfilled_${input.paymentId}`, amountCents: input.amountCents, currency: "usd", paidAt: new Date(), metadataPaymentId: input.paymentId, metadataAppointmentId: input.appointmentId }));
      },
    };
    const result = await startBookingDepositCheckout(hold.appointmentId, adapter);
    assert.equal(result.kind, "ambiguous");
    const [appointment, payment, events] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } }),
      prisma.appointmentEvent.findMany({ where: { appointmentId: hold.appointmentId, type: "PAYMENT_CONFIRMED" } }),
    ]);
    assert.equal(appointment.status, "CONFIRMED");
    assert.equal(payment.status, "PAID");
    assert.equal(payment.providerPaymentIntentId, `pi_fulfilled_${payment.id}`);
    assert.equal(payment.providerCheckoutSessionId, `cs_fulfilled_${payment.id}`);
    assert.ok(payment.allocatedAt);
    assert.equal(events.length, 1);
  });

  it("keeps a capacity-one checkout hold ahead of a competing new hold", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 1 }] });
    const customer = await createCustomer();
    const held = await acquireBookingHold({ customerId: customer.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.tuesday });
    const competitor = await createCustomer();
    const stripe = stripeDouble();
    const [checkout, newHold] = await Promise.allSettled([
      startBookingDepositCheckout(held.appointmentId, stripe.adapter),
      acquireBookingHold({ customerId: competitor.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.tuesday }),
    ]);
    assert.equal(checkout.status, "fulfilled");
    assert.equal(newHold.status, "rejected");
    assert.equal(stripe.calls(), 1);
    assert.equal(await prisma.appointment.count({ where: { bookingSlotId: slot.id, appointmentDate: new Date(`${WEEK.tuesday}T00:00:00.000Z`), status: "PENDING_PAYMENT" } }), 1);
  });

  it("does not create a session when an expired original hold loses capacity to a new hold", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 1 }] });
    const originalCustomer = await createCustomer();
    const original = await insertAppointment({ slot, customerId: originalCustomer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() - 120_000) });
    const competitor = await createCustomer();
    await acquireBookingHold({ customerId: competitor.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.tuesday });
    const stripe = stripeDouble();
    await assert.rejects(startBookingDepositCheckout(original.id, stripe.adapter));
    assert.equal(stripe.calls(), 0);
    assert.equal(await prisma.payment.count({ where: { appointmentId: original.id } }), 0);
    assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: original.id, type: "HOLD_EXPIRY_CHANGED" } }), 0);
  });

  it("rolls back Payment insertion with hold, events, snapshots, and capacity intact", async () => {
    const hold = await heldAppointment();
    const before = await checkoutSnapshot(hold.appointmentId);
    await withDatabaseFault('CREATE TRIGGER checkout_test_fault_trigger BEFORE INSERT ON "Payment" FOR EACH ROW EXECUTE FUNCTION checkout_test_fault();', async () => {
      await assert.rejects(startBookingDepositCheckout(hold.appointmentId, stripeDouble().adapter), /checkout test fault/);
    });
    const after = await checkoutSnapshot(hold.appointmentId);
    assert.equal(after.payments.length, 0);
    assert.equal(after.appointment.holdExpiresAt?.getTime(), before.appointment.holdExpiresAt?.getTime());
    assert.deepEqual(after.events.map((event) => event.type), before.events.map((event) => event.type));
    assert.deepEqual([after.appointment.totalPriceCents, after.appointment.depositAmountCents, after.appointment.balanceDueCents], [20_000, 4_000, 16_000]);
  });

  it("rolls back a hold update and prior Payment insertion", async () => {
    const hold = await heldAppointment();
    const before = await checkoutSnapshot(hold.appointmentId);
    await withDatabaseFault('CREATE TRIGGER checkout_test_fault_trigger BEFORE UPDATE OF "holdExpiresAt" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION checkout_test_fault();', async () => {
      await assert.rejects(startBookingDepositCheckout(hold.appointmentId, stripeDouble().adapter), /checkout test fault/);
    });
    const after = await checkoutSnapshot(hold.appointmentId);
    assert.equal(after.payments.length, 0);
    assert.equal(after.appointment.holdExpiresAt?.getTime(), before.appointment.holdExpiresAt?.getTime());
    assert.deepEqual(after.events.map((event) => event.type), ["CREATED"]);
  });

  it("rolls back Payment and hold update when the checkout audit event fails", async () => {
    const hold = await heldAppointment();
    const before = await checkoutSnapshot(hold.appointmentId);
    await withDatabaseFault('CREATE TRIGGER checkout_test_fault_trigger BEFORE INSERT ON "AppointmentEvent" FOR EACH ROW WHEN (NEW."type" = \'HOLD_EXPIRY_CHANGED\') EXECUTE FUNCTION checkout_test_fault();', async () => {
      await assert.rejects(startBookingDepositCheckout(hold.appointmentId, stripeDouble().adapter), /checkout test fault/);
    });
    const after = await checkoutSnapshot(hold.appointmentId);
    assert.equal(after.payments.length, 0);
    assert.equal(after.appointment.holdExpiresAt?.getTime(), before.appointment.holdExpiresAt?.getTime());
    assert.deepEqual(after.events.map((event) => event.type), ["CREATED"]);
  });

  it("returns ambiguous when Session-ID persistence fails without a second provider creation", async () => {
    const hold = await heldAppointment();
    const stripe = stripeDouble();
    await withDatabaseFault('CREATE TRIGGER checkout_test_fault_trigger BEFORE UPDATE OF "providerCheckoutSessionId" ON "Payment" FOR EACH ROW EXECUTE FUNCTION checkout_test_fault();', async () => {
      const result = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
      assert.equal(result.kind, "ambiguous");
    });
    const after = await checkoutSnapshot(hold.appointmentId);
    assert.equal(after.payments.length, 1);
    assert.equal(after.payments[0].status, "PENDING");
    assert.equal(after.payments[0].providerCheckoutSessionId, null);
    assert.ok(after.appointment.holdExpiresAt!.getTime() > hold.holdExpiresAt.getTime());
    assert.equal(stripe.calls(), 1);
    const retry = await startBookingDepositCheckout(hold.appointmentId, stripe.adapter);
    assert.equal(retry.kind, "ambiguous");
    assert.equal(stripe.calls(), 1);
  });

  it("uses an injected clock at the exact 60-second hold boundary", async () => {
    const { slot } = await createLocation();
    const customer = await createCustomer();
    const now = new Date("2027-03-01T15:00:00.000Z");
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 60_000) });
    const stripe = stripeDouble();
    const result = await startBookingDepositCheckout(appointment.id, stripe.adapter, fixedClock(now));
    assert.equal(result.kind, "ready");
    assert.equal(stripe.calls(), 1);
  });

  it("starts Checkout only from an issued booking-access token", async () => {
    const hold = await heldAppointment();
    const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId));
    const stripe = stripeDouble();
    const result = await startAuthorizedBookingCheckout(access.token, { adapter: stripe.adapter });
    assert.equal(result.kind, "ready"); assert.equal(stripe.calls(), 1);
    await assert.rejects(startAuthorizedBookingCheckout("invalid", { adapter: stripe.adapter }));
  });

  it("rejects unknown, malformed, missing, expired, boundary-expired, revoked, and unissued credentials without writes", async () => {
    const cases: Array<{ token: unknown; prepare?: (id: string) => Promise<void> }> = [
      { token: "A".repeat(43) }, { token: "malformed" }, { token: undefined },
      { token: "later" }, { token: "boundary" }, { token: "revoked" }, { token: "unissued" },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const hold = await heldAppointment(); const stripe = stripeDouble(); let token = cases[index].token;
      if (index >= 3 && index <= 5) {
        const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId)); token = access.token;
        if (index === 3 || index === 4) { const expiry = new Date(Date.now() - (index === 3 ? 1_000 : 0)); await prisma.appointment.update({ where: { id: hold.appointmentId }, data: { accessTokenIssuedAt: new Date(expiry.getTime() - 24 * 60 * 60_000), accessTokenExpiresAt: expiry } }); }
        if (index === 5) await revokeBookingAccess({ appointmentId: hold.appointmentId, reason: "customer-request", actorId: "test-admin" });
      }
      const before = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
      await assert.rejects(startAuthorizedBookingCheckout(token, { adapter: stripe.adapter }), BookingAccessError);
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
      assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 0); assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }), 0); assert.equal(stripe.calls(), 0); assert.equal(after.status, before.status); assert.equal(after.holdExpiresAt?.getTime(), before.holdExpiresAt?.getTime());
    }
  });

  it("keeps booking-access tokens isolated to their own appointments", async () => {
    const a = await heldAppointment(); const b = await heldAppointment();
    const [accessA, accessB] = await prisma.$transaction(async (tx) => [await issueBookingAccess(tx, a.appointmentId), await issueBookingAccess(tx, b.appointmentId)]);
    const stripe = stripeDouble();
    const result = await startAuthorizedBookingCheckout(accessA.token, { adapter: stripe.adapter });
    assert.equal(result.kind, "ready"); assert.equal(await prisma.payment.count({ where: { appointmentId: a.appointmentId } }), 1); assert.equal(await prisma.payment.count({ where: { appointmentId: b.appointmentId } }), 0);
    assert.notEqual(accessA.token, accessB.token);
  });
  it("rejects a credential revoked after resolution and before the locked checkpoint", async () => {
    const hold = await heldAppointment(); const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId)); const stripe = stripeDouble();
    let resolved!: () => void; const resolvedPromise = new Promise<void>((resolve) => { resolved = resolve; }); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const starting = startAuthorizedBookingCheckout(access.token, { adapter: stripe.adapter, afterAccessResolved: async () => { resolved(); await gate; } });
    await resolvedPromise;
    await revokeBookingAccess({ appointmentId: hold.appointmentId, reason: "customer-request", actorId: "test-admin" });
    release(); await assert.rejects(starting, BookingAccessError);
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 0); assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }), 0); assert.equal(stripe.calls(), 0); assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "ACCESS_REVOKED" } }), 1);
  });
  it("serializes two authorized Checkout starts to one payment and provider creation", async () => {
    const hold = await heldAppointment(); const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId)); const stripe = stripeDouble();
    const outcomes = await Promise.all([startAuthorizedBookingCheckout(access.token, { adapter: stripe.adapter }), startAuthorizedBookingCheckout(access.token, { adapter: stripe.adapter })]);
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 1); assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }), 1); assert.equal(stripe.calls(), 1); assert.deepEqual(outcomes.map((x) => x.kind).sort(), ["ambiguous", "ready"]);
  });
  it("rejects cancelled booking state after authorized token resolution", async () => {
    const hold = await heldAppointment(); const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId)); const stripe = stripeDouble(); let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; }); let reached!: () => void; const reachedGate = new Promise<void>((resolve) => { reached = resolve; });
    const starting = startAuthorizedBookingCheckout(access.token, { adapter: stripe.adapter, afterAccessResolved: async () => { reached(); await gate; } }); await reachedGate;
    await cancelAppointment(hold.appointmentId); resume(); await assert.rejects(starting, /not eligible/);
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 0); assert.equal(stripe.calls(), 0); assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: hold.appointmentId, type: "HOLD_EXPIRY_CHANGED" } }), 0);
  });
  it("preserves verified fulfillment when authorized Checkout resumes after access resolution", async () => {
    const hold = await heldAppointment(); const firstStripe = stripeDouble(); const started = await startBookingDepositCheckout(hold.appointmentId, firstStripe.adapter); assert.equal(started.kind, "ready");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId: hold.appointmentId, purpose: "BOOKING_DEPOSIT" } } }); const access = await prisma.$transaction((tx) => issueBookingAccess(tx, hold.appointmentId));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let reached!: () => void; const reachedGate = new Promise<void>((resolve) => { reached = resolve; }); const resumedStripe = stripeDouble();
    const waiting = startAuthorizedBookingCheckout(access.token, { adapter: resumedStripe.adapter, afterAccessResolved: async () => { reached(); await gate; } }); await reachedGate;
    await applyVerifiedCheckoutSession(verifiedCheckoutEvidence({ checkoutSessionId: payment.providerCheckoutSessionId!, sessionStatus: "complete", paymentStatus: "paid", paymentIntentId: `pi_authorized_${payment.id}`, amountCents: payment.amountCents, currency: "usd", paidAt: new Date(), metadataPaymentId: payment.id, metadataAppointmentId: hold.appointmentId }));
    release(); await assert.rejects(waiting, /not eligible/);
    const [appointment, after, events] = await Promise.all([prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } }), prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }), prisma.appointmentEvent.findMany({ where: { appointmentId: hold.appointmentId } })]);
    assert.equal(appointment.status, "CONFIRMED"); assert.equal(after.status, "PAID"); assert.ok(after.allocatedAt); assert.equal(await prisma.payment.count({ where: { appointmentId: hold.appointmentId } }), 1); assert.equal(resumedStripe.calls(), 0); assert.equal(events.filter((event) => event.type === "HOLD_EXPIRY_CHANGED").length, 1); assert.equal(events.filter((event) => event.type === "PAYMENT_CONFIRMED").length, 1);
  });

  it("rejects 59 seconds remaining before Payment, event, or Stripe", async () => {
    const { slot } = await createLocation(); const customer = await createCustomer(); const now = new Date("2027-03-01T15:00:00.000Z");
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 59_000) }); const stripe = stripeDouble();
    await assert.rejects(startBookingDepositCheckout(appointment.id, stripe.adapter, fixedClock(now)));
    assert.equal(await prisma.payment.count({ where: { appointmentId: appointment.id } }), 0); assert.equal(stripe.calls(), 0);
  });

  it("permits creation exactly at E minus 31 minutes", async () => {
    const { slot } = await createLocation(); const customer = await createCustomer(); const base = new Date("2027-03-01T15:00:00.000Z");
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(base.getTime() + 10 * 60_000) }); const stripe = stripeDouble(); sequenceClockIndex = 0;
    const result = await startBookingDepositCheckout(appointment.id, stripe.adapter, sequenceClock(base, new Date(base.getTime() + 3 * 60_000)));
    assert.equal(result.kind, "ready"); assert.equal(stripe.calls(), 1);
  });

  it("returns retry-window-expired one second past E minus 31 minutes", async () => {
    const { slot } = await createLocation(); const customer = await createCustomer(); const base = new Date("2027-03-01T15:00:00.000Z");
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: new Date(base.getTime() + 10 * 60_000) }); const stripe = stripeDouble(); sequenceClockIndex = 0;
    const result = await startBookingDepositCheckout(appointment.id, stripe.adapter, sequenceClock(base, new Date(base.getTime() + 3 * 60_000 + 1_000)));
    assert.equal(result.kind, "retry-window-expired"); assert.equal(stripe.calls(), 0); assert.equal(await prisma.payment.count({ where: { appointmentId: appointment.id } }), 1);
  });

  it("rejects an original hold exactly at expiry", async () => {
    const { slot } = await createLocation(); const customer = await createCustomer(); const now = new Date("2027-03-01T15:00:00.000Z");
    const appointment = await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.tuesday, status: "PENDING_PAYMENT", holdExpiresAt: now }); const stripe = stripeDouble();
    await assert.rejects(startBookingDepositCheckout(appointment.id, stripe.adapter, fixedClock(now))); assert.equal(await prisma.payment.count({ where: { appointmentId: appointment.id } }), 0); assert.equal(stripe.calls(), 0);
  });
});
