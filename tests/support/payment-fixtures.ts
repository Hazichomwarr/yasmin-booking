import assert from "node:assert/strict";

import type { AppointmentStatus, PaymentStatus } from "@prisma/client";

import { listAppointmentEvents } from "@/lib/booking";
import type { PaymentFulfillmentOutcome } from "@/lib/booking/payment-fulfillment";
import {
  verifiedCheckoutEvidence,
  type CheckoutEvidenceInput,
  type VerifiedCheckoutEvidence,
} from "@/lib/booking/payment-policy";
import { prisma } from "@/lib/prisma";

import { WEEK, createAppointmentIn, createLocation } from "./booking-fixtures";

/**
 * Payment test data and helpers (YASMIN-1E.3+). The payment services always
 * decide at the database clock, so fixtures are placed relative to it.
 * Synthetic identifiers only: nothing here is a Stripe object.
 */

export const MINUTE = 60_000;
export const DEPOSIT = 4000;

let sequence = 0;

export async function databaseNow(): Promise<Date> {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

export type Slot = Awaited<ReturnType<typeof createLocation>>["slot"];

/** One appointment with its deposit Payment, as checkout creation will leave them. */
export type Held = {
  slot: Slot;
  appointmentId: string;
  paymentId: string;
  session: string;
  intent: string;
  paidAt: Date;
};

export async function createPlace(options: { capacity?: number; slotActive?: boolean } = {}) {
  const { slot } = await createLocation({
    name: `Fulfillment ${++sequence}`,
    slots: [{ time: "11:00", capacity: options.capacity ?? 10, isActive: options.slotActive ?? true }],
  });
  return slot;
}

export async function createHeld(
  slot: Slot,
  options: {
    /** Hold expiry relative to the database clock; null for no hold expiry. */
    holdMinutes?: number | null;
    status?: AppointmentStatus;
    date?: string;
    paymentStatus?: PaymentStatus;
    /** Whether checkout creation already stored the session id. */
    bindSession?: boolean;
  } = {},
): Promise<Held> {
  const now = await databaseNow();
  const holdMinutes = options.holdMinutes === undefined ? 10 : options.holdMinutes;
  const appointment = await createAppointmentIn({
    slot,
    appointmentDate: options.date ?? WEEK.monday,
    status: options.status ?? "PENDING_PAYMENT",
    holdExpiresAt: holdMinutes === null ? null : new Date(now.getTime() + holdMinutes * MINUTE),
  });
  const n = ++sequence;
  const session = `cs_test_synthetic_${n}`;
  const payment = await prisma.payment.create({
    data: {
      appointmentId: appointment.id,
      provider: "STRIPE",
      purpose: "BOOKING_DEPOSIT",
      amountCents: DEPOSIT,
      status: options.paymentStatus ?? "PENDING",
      providerCheckoutSessionId: options.bindSession === false ? null : session,
    },
  });
  return {
    slot,
    appointmentId: appointment.id,
    paymentId: payment.id,
    session,
    intent: `pi_synthetic_${n}`,
    paidAt: new Date(Math.floor(now.getTime() / 1000) * 1000 - 30_000),
  };
}

export function paid(held: Held, overrides: Partial<CheckoutEvidenceInput> = {}): VerifiedCheckoutEvidence {
  return verifiedCheckoutEvidence({
    checkoutSessionId: held.session,
    sessionStatus: "complete",
    paymentStatus: "paid",
    paymentIntentId: held.intent,
    amountCents: DEPOSIT,
    currency: "usd",
    paidAt: held.paidAt,
    refundedOrPendingCents: 0,
    stripeEventId: `evt_synthetic_${++sequence}`,
    ...overrides,
  });
}

export function unpaid(held: Held, sessionStatus: "open" | "expired"): VerifiedCheckoutEvidence {
  return verifiedCheckoutEvidence({ checkoutSessionId: held.session, sessionStatus, paymentStatus: "unpaid" });
}

export function assertOutcome<K extends PaymentFulfillmentOutcome["kind"]>(
  outcome: PaymentFulfillmentOutcome,
  kind: K,
): asserts outcome is Extract<PaymentFulfillmentOutcome, { kind: K }> {
  assert.equal(outcome.kind, kind, JSON.stringify(outcome));
}

export function assertInconsistent(
  outcome: PaymentFulfillmentOutcome,
  problem: string,
  category: string,
): asserts outcome is Extract<PaymentFulfillmentOutcome, { kind: "inconsistent" }> {
  assertOutcome(outcome, "inconsistent");
  assert.equal(outcome.problem, problem);
  assert.equal(outcome.category, category);
}

export const paymentRow = (held: { paymentId: string }) => prisma.payment.findUniqueOrThrow({ where: { id: held.paymentId } });
export const appointmentStatus = async (held: { appointmentId: string }) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointmentId } })).status;

/** Asserts the Payment and Appointment were not touched. */
export async function assertUntouched(held: Held, expected: { payment: PaymentStatus; appointment: AppointmentStatus }) {
  const payment = await paymentRow(held);
  assert.equal(payment.status, expected.payment);
  assert.equal(payment.paidAt, null);
  assert.equal(payment.allocatedAt, null);
  assert.equal(payment.providerPaymentIntentId, null);
  assert.equal(payment.reconciliationReason, null);
  assert.equal(await appointmentStatus(held), expected.appointment);
  assert.deepEqual(await listAppointmentEvents(held.appointmentId), []);
}

/** Every Payment row satisfies the migration #3 invariants (also enforced by CHECKs). */
export async function assertPaymentInvariants() {
  const [{ checks }] = await prisma.$queryRaw<{ checks: number }[]>`
    SELECT count(*)::int AS checks FROM pg_constraint
    WHERE conrelid = '"Payment"'::regclass AND contype = 'c' AND convalidated
  `;
  assert.equal(checks, 11);
  const [{ violations }] = await prisma.$queryRaw<{ violations: number }[]>`
    SELECT count(*)::int AS violations FROM "Payment" WHERE NOT (
      "amountCents" > 0 AND "currency" ~ '^[a-z]{3}$'
      AND ("status" IN ('PAID', 'REFUNDED')) = ("paidAt" IS NOT NULL)
      AND ("paidAt" IS NULL OR "providerPaymentIntentId" IS NOT NULL)
      AND ("allocatedAt" IS NULL OR "paidAt" IS NOT NULL)
      AND ("paidAt" IS NULL OR "allocatedAt" IS NOT NULL OR "reconciliationReason" IS NOT NULL)
      AND ("reconciliationReason" IS NULL OR "paidAt" IS NOT NULL)
      AND "refundedAmountCents" BETWEEN 0 AND "amountCents"
      AND ("refundedAmountCents" = 0 OR "paidAt" IS NOT NULL)
      AND ("status" = 'REFUNDED') = ("paidAt" IS NOT NULL AND "refundedAmountCents" = "amountCents")
    )
  `;
  assert.equal(violations, 0);
}

/**
 * Barrier: holds a row lock on its own connection until released, so
 * contenders started meanwhile all queue on it.
 */
export async function holdRowLock(table: "Appointment" | "BookingSlot", id: string) {
  let release!: () => void;
  let acquired!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
      acquired();
      await released;
    },
    { timeout: 20_000 },
  );
  await ready;
  return async () => {
    release();
    await done;
  };
}

/** Waits until `count` backends of this database are blocked on a lock. */
export async function waitForLockWaiters(count: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if (waiting >= count) return;
    if (Date.now() > deadline) {
      const activity = await prisma.$queryRaw<unknown[]>`
        SELECT pid, state, wait_event_type, wait_event, left(query, 80) AS query FROM pg_stat_activity
        WHERE datname = current_database()
      `;
      throw new Error(`only ${waiting} of ${count} expected lock waiters: ${JSON.stringify(activity)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
