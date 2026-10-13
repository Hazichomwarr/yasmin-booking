import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import { acquireBookingHold, cancelAppointment, isBookingError, listAppointmentEvents } from "@/lib/booking";
import type {
  PaymentConfirmedEventDetails,
  PaymentReceivedUnconfirmedEventDetails,
} from "@/lib/booking/appointment-events";
import {
  applyVerifiedCheckoutSession,
  type PaymentFulfillmentOutcome,
} from "@/lib/booking/payment-fulfillment";
import {
  verifiedCheckoutEvidence,
  type VerifiedCheckoutEvidence,
} from "@/lib/booking/payment-policy";
import { prisma } from "@/lib/prisma";

import {
  WEEK,
  consumedIn,
  createCustomer,
  withFailingWrites,
} from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import {
  DEPOSIT,
  appointmentStatus,
  assertInconsistent,
  assertOutcome,
  assertPaymentInvariants,
  assertUntouched,
  createHeld,
  createPlace,
  databaseNow,
  holdRowLock,
  paid,
  paymentRow,
  unpaid,
  waitForLockWaiters,
  type Held,
} from "../support/payment-fixtures";

/**
 * YASMIN-1E.3 payment fulfillment against real PostgreSQL. Concurrency uses
 * real separate connections (Prisma's pool) and explicit lock barriers.
 *
 * Fixtures: tests/support/payment-fixtures.ts (placed relative to the
 * database clock; synthetic identifiers only).
 */

const ROUNDS = 8;
/** A past Monday: closed by the date policy whatever today is. */
const PAST_MONDAY = "2026-01-05";

const snapshotOf = (held: { appointmentId: string }) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id: held.appointmentId },
    select: {
      customerId: true,
      locationId: true,
      bookingSlotId: true,
      appointmentDate: true,
      holdExpiresAt: true,
      locationNameSnapshot: true,
      slotTimeSnapshot: true,
      hairstyleId: true,
      hairstyleNameSnapshot: true,
      totalPriceCents: true,
      depositAmountCents: true,
      balanceDueCents: true,
      createdAt: true,
    },
  });

async function assertConfirmed(held: Held, outcome: PaymentFulfillmentOutcome, method: string) {
  assertOutcome(outcome, "confirmed");
  assert.equal(outcome.method, method);
  const payment = await paymentRow(held);
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerCheckoutSessionId, held.session);
  assert.equal(payment.providerPaymentIntentId, held.intent);
  assert.deepEqual(payment.paidAt, held.paidAt);
  assert.deepEqual(payment.allocatedAt, outcome.decidedAt);
  assert.equal(payment.reconciliationReason, null);
  assert.equal(await appointmentStatus(held), "CONFIRMED");

  const events = await listAppointmentEvents(held.appointmentId);
  assert.deepEqual(events.map((e) => e.type), ["PAYMENT_CONFIRMED"]);
  const details = events[0].details as PaymentConfirmedEventDetails;
  assert.equal(details.confirmation, method);
  assert.equal(details.allocatedAt, outcome.decidedAt.toISOString());
  assert.equal(details.decidedAt, outcome.decidedAt.toISOString());
  assert.equal(details.payment.paidAt, held.paidAt.toISOString());
  assert.ok(events[0].createdAt.getTime() >= outcome.decidedAt.getTime(), "event written after the decision");
  return details;
}

async function assertReconciled(held: Held, outcome: PaymentFulfillmentOutcome, reason: string, appointment: AppointmentStatus) {
  assertOutcome(outcome, "reconciled");
  assert.equal(outcome.reason, reason);
  const payment = await paymentRow(held);
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerPaymentIntentId, held.intent);
  assert.equal(payment.providerCheckoutSessionId, held.session);
  assert.deepEqual(payment.paidAt, held.paidAt);
  assert.equal(payment.allocatedAt, null);
  assert.equal(payment.reconciliationReason, reason);
  assert.equal(payment.refundedAmountCents, 0);
  assert.equal(payment.refundsSyncedAt, null);
  assert.equal(await appointmentStatus(held), appointment);

  const events = await listAppointmentEvents(held.appointmentId);
  assert.deepEqual(events.map((e) => e.type), ["PAYMENT_RECEIVED_UNCONFIRMED"]);
  const details = events[0].details as PaymentReceivedUnconfirmedEventDetails;
  assert.equal(details.reason, reason);
  assert.equal(details.appointmentStatus, appointment);
  assert.equal(details.decidedAt, outcome.decidedAt.toISOString());
  return details;
}

/**
 * Starts two contenders while a barrier lock is held, the first strictly
 * ahead of the second in the lock queue (PostgreSQL grants row locks to
 * waiters in arrival order), so both interleavings are exercised on purpose.
 */
async function queueInOrder<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
  const a = settleOne(first());
  await waitForLockWaiters(1);
  const b = settleOne(second());
  await waitForLockWaiters(2);
  // Wrapped so the caller can release the barrier before awaiting results.
  return { results: Promise.all([a, b]) };
}

const settleOne = <T>(promise: Promise<T>) => Promise.allSettled([promise]).then(([result]) => result);

const settle = <T>(promises: Promise<T>[]) => Promise.allSettled(promises);

function valuesOf<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
}

describe("payment fulfillment: confirmation", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("1. successful payment inside an active hold confirms; snapshots unchanged", async () => {
    const held = await createHeld(await createPlace());
    const before = await snapshotOf(held);

    const details = await assertConfirmed(held, await applyVerifiedCheckoutSession(paid(held)), "within-active-hold");

    assert.equal(details.hold.activeAtDecision, true);
    assert.equal(details.previousPaymentStatus, "PENDING");
    assert.deepEqual(details.capacity, { configured: 10, consumedByOthers: 0 });
    assert.deepEqual(await snapshotOf(held), before); // 26. incl. the hold expiry
    await assertPaymentInvariants();
  });

  it("2. after hold expiry with capacity available: confirms by reacquisition", async () => {
    const slot = await createPlace({ capacity: 2 });
    await createHeld(slot, { status: "CONFIRMED", holdMinutes: null });
    const held = await createHeld(slot, { holdMinutes: -1 });

    const details = await assertConfirmed(
      held,
      await applyVerifiedCheckoutSession(paid(held)),
      "reacquired-after-hold-expiry",
    );
    assert.equal(details.hold.activeAtDecision, false);
    assert.deepEqual(details.capacity, { configured: 2, consumedByOthers: 1 });
  });

  it("an active hold still confirms when booking policy has since closed (existing terms kept)", async () => {
    const slot = await createPlace({ slotActive: false });
    const held = await createHeld(slot, { holdMinutes: 10 });
    await assertConfirmed(held, await applyVerifiedCheckoutSession(paid(held)), "within-active-hold");
  });

  it("19. lookup through trusted metadata when the session id was not stored; binds it", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const outcome = await applyVerifiedCheckoutSession(
      paid(held, { metadataPaymentId: held.paymentId, metadataAppointmentId: held.appointmentId }),
    );
    await assertConfirmed(held, outcome, "within-active-hold");
  });

  it("metadata that agrees with a stored session id is accepted", async () => {
    const held = await createHeld(await createPlace());
    const outcome = await applyVerifiedCheckoutSession(
      paid(held, { metadataPaymentId: held.paymentId, metadataAppointmentId: held.appointmentId }),
    );
    await assertConfirmed(held, outcome, "within-active-hold");
  });

  it("13. a Payment marked EXPIRED, later verified paid, is recorded and confirmed", async () => {
    const held = await createHeld(await createPlace(), { paymentStatus: "EXPIRED", holdMinutes: 5 });
    const details = await assertConfirmed(held, await applyVerifiedCheckoutSession(paid(held)), "within-active-hold");
    assert.equal(details.previousPaymentStatus, "EXPIRED");
  });

  it("14. a Payment marked FAILED, later verified paid, is recorded and confirmed", async () => {
    const held = await createHeld(await createPlace(), { paymentStatus: "FAILED", holdMinutes: -5 });
    const details = await assertConfirmed(
      held,
      await applyVerifiedCheckoutSession(paid(held)),
      "reacquired-after-hold-expiry",
    );
    assert.equal(details.previousPaymentStatus, "FAILED");
  });

  it("28. event chronology stays valid across hold, payment and later lifecycle events", async () => {
    const slot = await createPlace();
    const customer = await createCustomer();
    const hold = await acquireBookingHold({
      customerId: customer.id,
      locationId: slot.locationId,
      bookingSlotId: slot.id,
      appointmentDate: WEEK.tuesday,
    });
    const payment = await prisma.payment.create({
      data: {
        appointmentId: hold.appointmentId,
        provider: "STRIPE",
        purpose: "BOOKING_DEPOSIT",
        amountCents: hold.depositAmountCents,
        providerCheckoutSessionId: "cs_test_synthetic_chronology",
      },
    });
    const outcome = await applyVerifiedCheckoutSession(
      verifiedCheckoutEvidence({
        checkoutSessionId: "cs_test_synthetic_chronology",
        sessionStatus: "complete",
        paymentStatus: "paid",
        paymentIntentId: "pi_synthetic_chronology",
        amountCents: hold.depositAmountCents,
        currency: "usd",
        paidAt: new Date(Math.floor(Date.now() / 1000) * 1000),
      }),
    );
    assertOutcome(outcome, "confirmed");
    assert.equal(outcome.paymentId, payment.id);
    await cancelAppointment(hold.appointmentId);

    const events = await listAppointmentEvents(hold.appointmentId);
    assert.deepEqual(events.map((e) => e.type), ["CREATED", "PAYMENT_CONFIRMED", "CANCELLED"]);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].createdAt > events[i - 1].createdAt, "strictly increasing");
    }
    assert.ok(outcome.decidedAt > events[0].createdAt);
    assert.ok(outcome.decidedAt <= events[1].createdAt);
    // The cancelled appointment keeps its allocated charge; nothing refunds.
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(row.status, "PAID");
    assert.deepEqual(row.allocatedAt, outcome.allocatedAt);
  });
});

describe("payment fulfillment: reconciliation", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("3. after hold expiry with capacity full: recorded, PLACE_UNAVAILABLE, appointment untouched", async () => {
    const slot = await createPlace({ capacity: 1 });
    await createHeld(slot, { status: "CONFIRMED", holdMinutes: null });
    const held = await createHeld(slot, { holdMinutes: -1 });
    const before = await snapshotOf(held);

    const details = await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held)),
      "PLACE_UNAVAILABLE",
      "PENDING_PAYMENT",
    );
    assert.deepEqual(details.capacity, { configured: 1, consumedByOthers: 1 });
    assert.equal(details.bookingPolicyClosedReason, null);
    assert.deepEqual(await snapshotOf(held), before);
    assert.equal(await consumedIn(slot.id, WEEK.monday, await databaseNow()), 1);
    await assertPaymentInvariants();
  });

  it("4. active hold with an unexpected capacity conflict: never overbooks", async () => {
    const slot = await createPlace({ capacity: 1 });
    await createHeld(slot, { status: "CONFIRMED", holdMinutes: null }); // e.g. capacity reduced by an admin
    const held = await createHeld(slot, { holdMinutes: 10 });

    const details = await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held)),
      "PLACE_UNAVAILABLE",
      "PENDING_PAYMENT",
    );
    assert.equal(details.hold.activeAtDecision, true);
    // The confirmed appointment plus this still-active hold: nothing was added.
    assert.equal(await consumedIn(slot.id, WEEK.monday, await databaseNow()), 2);
  });

  for (const [label, setup, reason] of [
    ["past date", { date: PAST_MONDAY }, "INVALID_APPOINTMENT_DATE"],
    ["weekend", { date: WEEK.saturday }, "ONLINE_BOOKING_CLOSED_FOR_DAY"],
    ["inactive slot", { slotActive: false }, "SLOT_NOT_BOOKABLE"],
  ] as const) {
    it(`5. expired hold with booking policy closed (${label}): PLACE_UNAVAILABLE + ${reason}`, async () => {
      const slot = await createPlace({ slotActive: "slotActive" in setup ? setup.slotActive : true });
      const held = await createHeld(slot, { holdMinutes: -1, date: "date" in setup ? setup.date : WEEK.monday });
      const details = await assertReconciled(
        held,
        await applyVerifiedCheckoutSession(paid(held)),
        "PLACE_UNAVAILABLE",
        "PENDING_PAYMENT",
      );
      assert.equal(details.bookingPolicyClosedReason, reason);
    });
  }

  it("5b. expired hold at a location that stopped online booking", async () => {
    const slot = await createPlace();
    const held = await createHeld(slot, { holdMinutes: -1 });
    await prisma.salonLocation.update({ where: { id: slot.locationId }, data: { acceptsOnlineBooking: false } });
    const details = await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held)),
      "PLACE_UNAVAILABLE",
      "PENDING_PAYMENT",
    );
    assert.equal(details.bookingPolicyClosedReason, "LOCATION_NOT_BOOKABLE");
  });

  it("6. a cancelled appointment receiving payment stays cancelled", async () => {
    const held = await createHeld(await createPlace(), { status: "CANCELLED" });
    await assertReconciled(held, await applyVerifiedCheckoutSession(paid(held)), "APPOINTMENT_NOT_PAYABLE", "CANCELLED");
  });

  it("15. amount mismatch: recorded with the verified amount in the event, record amount kept", async () => {
    const held = await createHeld(await createPlace());
    const details = await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held, { amountCents: 3999 })),
      "AMOUNT_MISMATCH",
      "PENDING_PAYMENT",
    );
    assert.equal(details.payment.amountCents, 3999);
    assert.deepEqual(details.recorded, { amountCents: DEPOSIT, currency: "usd" });
    assert.equal((await paymentRow(held)).amountCents, DEPOSIT);
  });

  it("16. currency mismatch", async () => {
    const held = await createHeld(await createPlace());
    const details = await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held, { currency: "eur" })),
      "AMOUNT_MISMATCH",
      "PENDING_PAYMENT",
    );
    assert.equal(details.payment.currency, "eur");
    assert.equal((await paymentRow(held)).currency, "usd");
  });

  it("refund activity before allocation: not allocated, refund amounts not invented", async () => {
    const held = await createHeld(await createPlace());
    await assertReconciled(
      held,
      await applyVerifiedCheckoutSession(paid(held, { refundedOrPendingCents: 1000 })),
      "REFUNDED_BEFORE_ALLOCATION",
      "PENDING_PAYMENT",
    );
  });
});

describe("payment fulfillment: idempotency and identity", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("11. duplicate after allocation: no-op, one event, even after the appointment moved on", async () => {
    const held = await createHeld(await createPlace());
    const evidence = paid(held);
    assertOutcome(await applyVerifiedCheckoutSession(evidence), "confirmed");
    const afterFirst = await paymentRow(held);

    assertOutcome(await applyVerifiedCheckoutSession(evidence), "already-allocated");
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "already-allocated"); // new event id
    await cancelAppointment(held.appointmentId);
    assertOutcome(await applyVerifiedCheckoutSession(evidence), "already-allocated");

    assert.deepEqual(await paymentRow(held), afterFirst);
    assert.deepEqual(
      (await listAppointmentEvents(held.appointmentId)).map((e) => e.type),
      ["PAYMENT_CONFIRMED", "CANCELLED"],
    );
  });

  it("12. duplicate after reconciliation never allocates, even once a place frees up", async () => {
    const slot = await createPlace({ capacity: 1 });
    const other = await createHeld(slot, { status: "CONFIRMED", holdMinutes: null });
    const held = await createHeld(slot, { holdMinutes: -1 });
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "reconciled");
    const afterFirst = await paymentRow(held);

    await cancelAppointment(other.appointmentId); // the place is free again
    const outcome = await applyVerifiedCheckoutSession(paid(held));
    assertOutcome(outcome, "already-recorded-unallocated");
    assert.equal(outcome.reason, "PLACE_UNAVAILABLE");
    assert.deepEqual(await paymentRow(held), afterFirst);
    assert.equal(await appointmentStatus(held), "PENDING_PAYMENT");
    assert.equal((await listAppointmentEvents(held.appointmentId)).length, 1);
  });

  it("17. PaymentIntent identity conflict on a recorded payment: nothing written, alert raised", async () => {
    const held = await createHeld(await createPlace());
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "confirmed");
    const afterFirst = await paymentRow(held);

    const outcome = await applyVerifiedCheckoutSession(paid(held, { paymentIntentId: "pi_synthetic_other" }));
    assertInconsistent(outcome, "PAYMENT_INTENT_MISMATCH", "identity-conflict");
    assert.equal(outcome.alert.unrecordedCharge, true);
    assert.equal(outcome.alert.paymentIntentId, "pi_synthetic_other");
    assert.equal(outcome.alert.paymentId, held.paymentId);
    assert.deepEqual(await paymentRow(held), afterFirst);
    assert.equal((await listAppointmentEvents(held.appointmentId)).length, 1);
  });

  it("17b. a PaymentIntent already recorded on another Payment is refused", async () => {
    const slot = await createPlace();
    const first = await createHeld(slot);
    const second = await createHeld(slot);
    assertOutcome(await applyVerifiedCheckoutSession(paid(first)), "confirmed");

    const outcome = await applyVerifiedCheckoutSession(paid(second, { paymentIntentId: first.intent }));
    assertInconsistent(outcome, "PROVIDER_IDENTITY_IN_USE", "identity-conflict");
    await assertUntouched(second, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("18. Checkout Session identity conflict: the Payment is bound to another session", async () => {
    const held = await createHeld(await createPlace());
    const outcome = await applyVerifiedCheckoutSession(
      paid(held, {
        checkoutSessionId: "cs_test_synthetic_other",
        metadataPaymentId: held.paymentId,
        metadataAppointmentId: held.appointmentId,
      }),
    );
    assertInconsistent(outcome, "CHECKOUT_SESSION_MISMATCH", "identity-conflict");
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("18b. session bound to one Payment while metadata names another", async () => {
    const slot = await createPlace();
    const first = await createHeld(slot);
    const second = await createHeld(slot);
    const outcome = await applyVerifiedCheckoutSession(
      paid(first, { metadataPaymentId: second.paymentId, metadataAppointmentId: second.appointmentId }),
    );
    assertInconsistent(outcome, "REFERENCE_MISMATCH", "identity-conflict");
    await assertUntouched(first, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
    await assertUntouched(second, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("20. incorrect metadata association never attaches a charge to another appointment", async () => {
    const slot = await createPlace();
    const held = await createHeld(slot, { bindSession: false });
    const unrelated = await createHeld(slot);

    const wrongAppointment = await applyVerifiedCheckoutSession(
      paid(held, { metadataPaymentId: held.paymentId, metadataAppointmentId: unrelated.appointmentId }),
    );
    assertInconsistent(wrongAppointment, "REFERENCE_MISMATCH", "identity-conflict");

    const missingPayment = await applyVerifiedCheckoutSession(
      paid(held, { metadataPaymentId: "pay_does_not_exist", metadataAppointmentId: held.appointmentId }),
    );
    assertInconsistent(missingPayment, "PAYMENT_NOT_FOUND", "missing-association");

    const noReference = await applyVerifiedCheckoutSession(paid(held));
    assertInconsistent(noReference, "PAYMENT_NOT_FOUND", "missing-association");
    assert.equal(noReference.alert.unrecordedCharge, true);

    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
    await assertUntouched(unrelated, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("evidence not produced by verifiedCheckoutEvidence is refused without trusting it", async () => {
    const held = await createHeld(await createPlace());
    const forged = { ...paid(held) } as VerifiedCheckoutEvidence; // same fields, not issued
    const outcome = await applyVerifiedCheckoutSession(forged);
    assertInconsistent(outcome, "EVIDENCE_NOT_VERIFIED", "unusable-evidence");
    assert.equal(outcome.alert.paymentId, null);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("corrupt local Payment state is reported, not repaired", async () => {
    const held = await createHeld(await createPlace());
    await prisma.payment.update({ where: { id: held.paymentId }, data: { amountCents: 5000 } }); // ≠ deposit snapshot
    const outcome = await applyVerifiedCheckoutSession(paid(held));
    assertInconsistent(outcome, "LOCAL_RECORD_INVALID", "corrupt-local-state");
    assert.equal((await paymentRow(held)).status, "PENDING");
  });

  it("21. unpaid open session: nothing changes", async () => {
    const held = await createHeld(await createPlace());
    const outcome = await applyVerifiedCheckoutSession(unpaid(held, "open"));
    assertOutcome(outcome, "not-paid");
    assert.equal(outcome.paymentExpired, false);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("22. expired unpaid session marks the Payment EXPIRED once, without events", async () => {
    const held = await createHeld(await createPlace());
    const first = await applyVerifiedCheckoutSession(unpaid(held, "expired"));
    assertOutcome(first, "not-paid");
    assert.equal(first.paymentExpired, true);
    const again = await applyVerifiedCheckoutSession(unpaid(held, "expired"));
    assertOutcome(again, "not-paid");
    assert.equal(again.paymentExpired, false);
    await assertUntouched(held, { payment: "EXPIRED", appointment: "PENDING_PAYMENT" });
  });

  it("an unpaid report never downgrades a PAID Payment", async () => {
    const held = await createHeld(await createPlace());
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "confirmed");
    const outcome = await applyVerifiedCheckoutSession(unpaid(held, "expired"));
    assertInconsistent(outcome, "LOCAL_PAID_BUT_PROVIDER_UNPAID", "identity-conflict");
    assert.equal(outcome.alert.unrecordedCharge, false);
    assert.equal((await paymentRow(held)).status, "PAID");
  });
});

describe("payment fulfillment: atomicity", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("23. failure after the Payment update, before the transition and event: all rolled back", async () => {
    const held = await createHeld(await createPlace());
    await assert.rejects(
      withFailingWrites("Appointment", "UPDATE", () => applyVerifiedCheckoutSession(paid(held))),
      /forced test failure/,
    );
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("23b. reconciliation: failure after the Payment update, at the event append", async () => {
    const held = await createHeld(await createPlace(), { status: "CANCELLED" });
    await assert.rejects(
      withFailingWrites("AppointmentEvent", "INSERT", () => applyVerifiedCheckoutSession(paid(held))),
      /forced test failure/,
    );
    await assertUntouched(held, { payment: "PENDING", appointment: "CANCELLED" });
  });

  it("24. failure after the transition and event, at commit: all rolled back; a retry succeeds", async () => {
    const held = await createHeld(await createPlace());
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_commit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced test failure at commit'; END $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER test_fail_commit AFTER UPDATE ON "Appointment"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_commit()
    `);
    try {
      await assert.rejects(applyVerifiedCheckoutSession(paid(held)), /forced test failure at commit/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_commit ON "Appointment"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_commit()`);
    }
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });

    await assertConfirmed(held, await applyVerifiedCheckoutSession(paid(held)), "within-active-hold");
  });
});

describe("payment fulfillment: concurrency", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it(`7. confirmation racing cancellation stays consistent (${ROUNDS} rounds)`, async () => {
    const slot = await createPlace({ capacity: 50 });
    const seen = { confirmedThenCancelled: 0, cancelledThenReconciled: 0 };
    for (let round = 1; round <= ROUNDS; round++) {
      const held = await createHeld(slot);
      const confirm = () => applyVerifiedCheckoutSession(paid(held));
      const cancel = () => cancelAppointment(held.appointmentId);
      const release = await holdRowLock("Appointment", held.appointmentId);
      const { results } = round % 2 ? await queueInOrder(confirm, cancel) : await queueInOrder(cancel, confirm);
      await release();
      const settled = await results;
      const [paymentResult, cancelResult] = round % 2 ? settled : [settled[1], settled[0]];
      assert.equal(cancelResult.status, "fulfilled", "cancel succeeds from either state");
      assert.equal(paymentResult.status, "fulfilled");
      const outcome = (paymentResult as PromiseFulfilledResult<PaymentFulfillmentOutcome>).value;

      const payment = await paymentRow(held);
      const types = (await listAppointmentEvents(held.appointmentId)).map((e) => e.type);
      assert.equal(await appointmentStatus(held), "CANCELLED");
      assert.equal(payment.status, "PAID");
      if (outcome.kind === "confirmed") {
        seen.confirmedThenCancelled += 1;
        assert.deepEqual(types, ["PAYMENT_CONFIRMED", "CANCELLED"]);
        assert.notEqual(payment.allocatedAt, null);
      } else {
        seen.cancelledThenReconciled += 1;
        assertOutcome(outcome, "reconciled");
        assert.equal(outcome.reason, "APPOINTMENT_NOT_PAYABLE");
        assert.deepEqual(types, ["CANCELLED", "PAYMENT_RECEIVED_UNCONFIRMED"]);
        assert.equal(payment.allocatedAt, null);
      }
    }
    console.log(`    confirmation-vs-cancel outcomes: ${JSON.stringify(seen)}`);
    assert.ok(seen.confirmedThenCancelled > 0 && seen.cancelledThenReconciled > 0, "both orders exercised");
    await assertPaymentInvariants();
  });

  it(`8. confirmation racing a new hold for the last place: exactly one gets it (${ROUNDS} rounds)`, async () => {
    const seen = { paymentWon: 0, holdWon: 0 };
    for (let round = 1; round <= ROUNDS; round++) {
      const slot = await createPlace({ capacity: 1 });
      const held = await createHeld(slot, { holdMinutes: -1 });
      const customer = await createCustomer();

      const confirm = () => applyVerifiedCheckoutSession(paid(held));
      const acquire = () =>
        acquireBookingHold({
          customerId: customer.id,
          locationId: slot.locationId,
          bookingSlotId: slot.id,
          appointmentDate: WEEK.monday,
        });
      const release = await holdRowLock("BookingSlot", slot.id);
      const { results } = round % 2 ? await queueInOrder(confirm, acquire) : await queueInOrder(acquire, confirm);
      await release();
      const settled = await results;
      const [payment, hold] = round % 2 ? settled : [settled[1], settled[0]];

      assert.equal(payment.status, "fulfilled");
      const outcome = (payment as PromiseFulfilledResult<PaymentFulfillmentOutcome>).value;
      if (outcome.kind === "confirmed") {
        seen.paymentWon += 1;
        assert.equal(hold.status, "rejected");
        assert.ok(isBookingError((hold as PromiseRejectedResult).reason, "CAPACITY_FULL"));
      } else {
        seen.holdWon += 1;
        assertOutcome(outcome, "reconciled");
        assert.equal(outcome.reason, "PLACE_UNAVAILABLE");
        assert.equal(hold.status, "fulfilled");
      }
      assert.equal(await consumedIn(slot.id, WEEK.monday, await databaseNow()), 1, `round ${round}`);
    }
    console.log(`    confirmation-vs-hold outcomes: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, { paymentWon: ROUNDS / 2, holdWon: ROUNDS / 2 }, "the first in the lock queue wins");
  });

  it(`9. two confirmations compete for the last place: one confirms, one reconciles (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const slot = await createPlace({ capacity: 1 });
      const a = await createHeld(slot, { holdMinutes: -1 });
      const b = await createHeld(slot, { holdMinutes: -1 });

      const release = await holdRowLock("BookingSlot", slot.id);
      const racing = settle([applyVerifiedCheckoutSession(paid(a)), applyVerifiedCheckoutSession(paid(b))]);
      await waitForLockWaiters(2);
      await release();
      const kinds = valuesOf(await racing).map((o) => (o.kind === "reconciled" ? `${o.kind}:${o.reason}` : o.kind));

      assert.deepEqual(kinds.sort(), ["confirmed", "reconciled:PLACE_UNAVAILABLE"], `round ${round}`);
      assert.equal(await consumedIn(slot.id, WEEK.monday, await databaseNow()), 1);
    }
    await assertPaymentInvariants();
  });

  it(`10. duplicate evidence processed concurrently: one confirmation, one event (${ROUNDS} rounds)`, async () => {
    const slot = await createPlace({ capacity: 50 });
    for (let round = 1; round <= ROUNDS; round++) {
      const held = await createHeld(slot);
      const evidence = paid(held);
      const release = await holdRowLock("Appointment", held.appointmentId);
      const racing = settle([
        applyVerifiedCheckoutSession(evidence),
        applyVerifiedCheckoutSession(evidence),
        applyVerifiedCheckoutSession(paid(held)), // same charge, different webhook event
        applyVerifiedCheckoutSession(evidence),
      ]);
      await waitForLockWaiters(4);
      await release();
      const kinds = valuesOf(await racing).map((o) => o.kind).sort();

      assert.deepEqual(kinds, ["already-allocated", "already-allocated", "already-allocated", "confirmed"]);
      assert.deepEqual((await listAppointmentEvents(held.appointmentId)).map((e) => e.type), ["PAYMENT_CONFIRMED"]);
    }
  });

  it(`the same PaymentIntent claimed for two Payments at once: the unique index refuses the second (${ROUNDS} rounds)`, async () => {
    const slot = await createPlace({ capacity: 50 });
    for (let round = 1; round <= ROUNDS; round++) {
      const a = await createHeld(slot);
      const b = await createHeld(slot);
      // Both pass the in-transaction PaymentIntent check, then queue on the
      // slot lock; the second one's write hits the unique index.
      const release = await holdRowLock("BookingSlot", slot.id);
      const { results } = await queueInOrder(
        () => applyVerifiedCheckoutSession(paid(a)),
        () => applyVerifiedCheckoutSession(paid(b, { paymentIntentId: a.intent })),
      );
      await release();
      const [first, second] = valuesOf(await results);

      assertOutcome(first, "confirmed");
      assertInconsistent(second, "PROVIDER_IDENTITY_IN_USE", "identity-conflict");
      assert.equal(second.alert.paymentId, b.paymentId);
      assert.equal(second.alert.unrecordedCharge, true);
      await assertUntouched(b, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
    }
  });

  it(`25. no overbooking across repeated mixed races (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const slot = await createPlace({ capacity: 3 });
      await createHeld(slot, { status: "CONFIRMED", holdMinutes: null });
      const expired = await Promise.all([1, 2, 3].map(() => createHeld(slot, { holdMinutes: -1 })));
      const active = await createHeld(slot, { holdMinutes: 10 });
      const customers = await Promise.all([1, 2].map(() => createCustomer()));

      const results = await settle<unknown>([
        ...expired.map((held) => applyVerifiedCheckoutSession(paid(held))),
        applyVerifiedCheckoutSession(paid(active)),
        ...customers.map((customer) =>
          acquireBookingHold({
            customerId: customer.id,
            locationId: slot.locationId,
            bookingSlotId: slot.id,
            appointmentDate: WEEK.monday,
          }),
        ),
      ]);

      const unexpected = results.filter(
        (r) => r.status === "rejected" && !isBookingError(r.reason, "CAPACITY_FULL"),
      );
      assert.deepEqual(unexpected, [], `round ${round}: no deadlocks or other errors`);
      const consumed = await consumedIn(slot.id, WEEK.monday, await databaseNow());
      assert.ok(consumed <= 3, `round ${round}: ${consumed} > capacity`);

      for (const held of [...expired, active]) {
        const payment = await paymentRow(held);
        assert.equal(payment.status, "PAID", "every verified charge is recorded");
        assert.ok((payment.allocatedAt === null) !== (payment.reconciliationReason === null));
        const events = await listAppointmentEvents(held.appointmentId);
        assert.equal(events.length, 1, "27. exactly one event per recorded charge");
        assert.equal(
          events[0].type,
          payment.allocatedAt ? "PAYMENT_CONFIRMED" : "PAYMENT_RECEIVED_UNCONFIRMED",
        );
      }
    }
    await assertPaymentInvariants();
  });

  it("29. legitimate fast paths never wait for the BookingSlot lock; a first receipt does", async () => {
    const slot = await createPlace();
    const allocated = await createHeld(slot);
    const reconciled = await createHeld(slot, { status: "CANCELLED" });
    const open = await createHeld(slot);
    const fresh = await createHeld(slot);
    assertOutcome(await applyVerifiedCheckoutSession(paid(allocated)), "confirmed");
    assertOutcome(await applyVerifiedCheckoutSession(paid(reconciled)), "reconciled");

    const release = await holdRowLock("BookingSlot", slot.id);
    try {
      const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3000));
      for (const [evidence, kind] of [
        [paid(allocated), "already-allocated"],
        [paid(reconciled), "already-recorded-unallocated"],
        [unpaid(open, "open"), "not-paid"],
        [paid(allocated, { paymentIntentId: "pi_synthetic_conflict" }), "inconsistent"],
      ] as const) {
        const outcome = await Promise.race([applyVerifiedCheckoutSession(evidence), timeout]);
        assert.notEqual(outcome, "blocked", `${kind} waited for the slot lock`);
        assert.equal((outcome as PaymentFulfillmentOutcome).kind, kind);
      }

      // Control: a first receipt must wait for the slot lock.
      const first = applyVerifiedCheckoutSession(paid(fresh));
      await waitForLockWaiters(1);
      assert.equal(await Promise.race([first.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 200))]), "waiting");
      await release();
      assertOutcome(await first, "confirmed");
    } finally {
      await release();
    }
  });
});
