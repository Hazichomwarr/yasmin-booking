import { Prisma, type PaymentReconciliationReason } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, type PaymentConfirmationMethod } from "./appointment-events";
import { lockAppointment } from "./appointments";
import { placePolicyClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity } from "./capacity";
import { isBookingError } from "./errors";
import {
  decidePaymentBeforePlace,
  decidePaymentConfirmation,
  isVerifiedCheckoutEvidence,
  paymentDecisionEvent,
  type PaymentConfirmationInput,
  type PaymentInconsistency,
  type PaymentRecordFacts,
  type PlaceIndependentInput,
  type VerifiedCheckoutEvidence,
} from "./payment-policy";
import { salonDateFromDatabase } from "./salon-calendar";

/**
 * Payment fulfillment — applies verified Stripe Checkout evidence to one
 * Payment and its Appointment, in one READ COMMITTED transaction.
 *
 * Every rule lives in payment-policy.ts; this module only gathers the facts
 * under the right locks and writes what the decision says. No Stripe calls,
 * no refunds, no capacity override. Internal: imported by path by the
 * future webhook / return-page adapters, not re-exported from the barrel.
 *
 * Lookup (before the transaction; Payment → Appointment links never change):
 *   1. the Payment whose providerCheckoutSessionId is the session id;
 *   2. otherwise the Payment named by the session's server-set metadata.
 *   If both exist they must agree, and the metadata appointment must be the
 *   Payment's appointment. Customer-facing input never reaches this module.
 *
 * Transaction (global lock order):
 *   1. Appointment FOR UPDATE.
 *   2. Payment FOR UPDATE.
 *   3. Place-independent decision (duplicates, unpaid, inconsistencies) —
 *      applied here without touching the BookingSlot.
 *   4. First receipt only: BookingSlot FOR UPDATE, then the decision instant
 *      (PostgreSQL clock_timestamp(), read once, after the last lock), then
 *      capacity used by others and booking policy at that instant.
 *   5. Write Payment, then (confirm only) Appointment, then exactly one event.
 *
 * The decision instant is never caller-supplied.
 *
 * Failures:
 * - Persistent problems (identity conflicts, corrupt local rows, missing
 *   associations, unusable evidence) return `inconsistent` and write
 *   nothing. Re-running the same evidence returns the same outcome until a
 *   human fixes the data; `alert` says what to investigate.
 * - Anything thrown (connection loss, deadlock, timeout, …) means nothing was
 *   committed. The operation is idempotent, so the caller retries.
 */

export type FulfillmentProblemCategory =
  /** Stripe and the database disagree about which charge/session/payment this is. */
  | "identity-conflict"
  /** The local Payment/Appointment/location rows break the payment invariants. */
  | "corrupt-local-state"
  /** No Payment (or Appointment) can be associated with the evidence. */
  | "missing-association"
  /** The evidence is not usable as proof (not verified, or not a deposit payment). */
  | "unusable-evidence";

export type FulfillmentProblem =
  | PaymentInconsistency
  /** The object was not produced by verifiedCheckoutEvidence. */
  | "EVIDENCE_NOT_VERIFIED"
  /** Neither the session id nor the session metadata identifies a Payment. */
  | "PAYMENT_NOT_FOUND"
  /** The session metadata names a different Payment or Appointment than the database. */
  | "REFERENCE_MISMATCH"
  /** Another Payment already holds this PaymentIntent or Checkout Session. */
  | "PROVIDER_IDENTITY_IN_USE"
  /** The appointment's location has an invalid time zone, so booking policy cannot be evaluated. */
  | "LOCATION_TIME_ZONE_INVALID";

const POLICY_PROBLEM_CATEGORY: Readonly<Record<PaymentInconsistency, FulfillmentProblemCategory>> = {
  LOCAL_RECORD_INVALID: "corrupt-local-state",
  ALLOCATED_BUT_APPOINTMENT_PENDING: "corrupt-local-state",
  CHECKOUT_SESSION_MISMATCH: "identity-conflict",
  PAYMENT_INTENT_MISMATCH: "identity-conflict",
  PAID_AT_MISMATCH: "identity-conflict",
  VERIFIED_AMOUNT_CHANGED: "identity-conflict",
  LOCAL_PAID_BUT_PROVIDER_UNPAID: "identity-conflict",
  NO_PAYMENT_REQUIRED: "unusable-evidence",
};

/** What an operator needs to investigate an inconsistent outcome. */
export type FulfillmentAlert = {
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  stripeEventId: string | null;
  paymentId: string | null;
  appointmentId: string | null;
  /** Stripe verified a successful charge that this call did NOT record. */
  unrecordedCharge: boolean;
};

export type PaymentFulfillmentOutcome =
  | {
      kind: "confirmed";
      paymentId: string;
      appointmentId: string;
      method: PaymentConfirmationMethod;
      allocatedAt: Date;
      decidedAt: Date;
    }
  | {
      kind: "reconciled";
      paymentId: string;
      appointmentId: string;
      reason: PaymentReconciliationReason;
      decidedAt: Date;
    }
  | { kind: "already-allocated"; paymentId: string; appointmentId: string }
  | {
      kind: "already-recorded-unallocated";
      paymentId: string;
      appointmentId: string;
      reason: PaymentReconciliationReason;
    }
  /** No money received. `paymentExpired`: this call moved the Payment PENDING → EXPIRED. */
  | { kind: "not-paid"; paymentId: string; appointmentId: string; paymentExpired: boolean }
  | {
      kind: "inconsistent";
      category: FulfillmentProblemCategory;
      problem: FulfillmentProblem;
      message: string;
      alert: FulfillmentAlert;
    };

export type InconsistentFulfillmentOutcome = Extract<PaymentFulfillmentOutcome, { kind: "inconsistent" }>;

type PaymentLink = { paymentId: string; appointmentId: string };

const paymentFactsSelect = {
  id: true,
  appointmentId: true,
  status: true,
  amountCents: true,
  currency: true,
  providerCheckoutSessionId: true,
  providerPaymentIntentId: true,
  paidAt: true,
  allocatedAt: true,
  refundedAmountCents: true,
  reconciliationReason: true,
} satisfies Prisma.PaymentSelect;

export async function applyVerifiedCheckoutSession(
  evidence: VerifiedCheckoutEvidence,
): Promise<PaymentFulfillmentOutcome> {
  if (!isVerifiedCheckoutEvidence(evidence)) {
    // Nothing from a look-alike object is trusted, not even for the alert.
    return inconsistentOutcome(
      null,
      null,
      "EVIDENCE_NOT_VERIFIED",
      "unusable-evidence",
      "Evidence was not produced by verifiedCheckoutEvidence.",
    );
  }

  const link = await resolvePayment(evidence);
  if ("kind" in link) return link;

  try {
    return await prisma.$transaction((tx) => fulfill(tx, evidence, link), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  } catch (error) {
    // A concurrent writer claimed the same provider identity on another
    // Payment between our check and our write. Persistent, not retryable.
    if (isProviderIdentityConflict(error)) {
      return inconsistentOutcome(
        evidence,
        link,
        "PROVIDER_IDENTITY_IN_USE",
        "identity-conflict",
        "Another Payment already holds this PaymentIntent or Checkout Session.",
      );
    }
    throw error;
  }
}

/** Finds the Payment the evidence belongs to, verifying every stated association. */
async function resolvePayment(evidence: VerifiedCheckoutEvidence): Promise<PaymentLink | InconsistentFulfillmentOutcome> {
  const reference = evidence.reference;
  const bySession = await prisma.payment.findUnique({
    where: { providerCheckoutSessionId: evidence.checkoutSessionId },
    select: { id: true, appointmentId: true },
  });

  if (bySession) {
    const link = { paymentId: bySession.id, appointmentId: bySession.appointmentId };
    if (reference && (reference.paymentId !== link.paymentId || reference.appointmentId !== link.appointmentId)) {
      return inconsistentOutcome(
        evidence,
        link,
        "REFERENCE_MISMATCH",
        "identity-conflict",
        `Checkout Session ${evidence.checkoutSessionId} belongs to Payment ${link.paymentId}, but its metadata names another Payment or Appointment.`,
      );
    }
    return link;
  }

  if (!reference) {
    return inconsistentOutcome(
      evidence,
      null,
      "PAYMENT_NOT_FOUND",
      "missing-association",
      `No Payment is bound to Checkout Session ${evidence.checkoutSessionId}, and the session carries no payment metadata.`,
    );
  }

  const byReference = await prisma.payment.findUnique({
    where: { id: reference.paymentId },
    select: { id: true, appointmentId: true },
  });
  if (!byReference) {
    return inconsistentOutcome(
      evidence,
      null,
      "PAYMENT_NOT_FOUND",
      "missing-association",
      `Payment ${reference.paymentId} named by Checkout Session ${evidence.checkoutSessionId} does not exist.`,
    );
  }
  const link = { paymentId: byReference.id, appointmentId: byReference.appointmentId };
  if (link.appointmentId !== reference.appointmentId) {
    return inconsistentOutcome(
      evidence,
      link,
      "REFERENCE_MISMATCH",
      "identity-conflict",
      `Payment ${link.paymentId} belongs to Appointment ${link.appointmentId}, not ${reference.appointmentId} as the session metadata states.`,
    );
  }
  // If this Payment is bound to another session, the policy reports
  // CHECKOUT_SESSION_MISMATCH under the locks.
  return link;
}

async function fulfill(
  tx: Prisma.TransactionClient,
  evidence: VerifiedCheckoutEvidence,
  link: PaymentLink,
): Promise<PaymentFulfillmentOutcome> {
  // 1. Appointment lock.
  let appointment;
  try {
    appointment = await lockAppointment(tx, link.appointmentId);
  } catch (error) {
    if (!isBookingError(error, "APPOINTMENT_NOT_FOUND")) throw error;
    return inconsistentOutcome(evidence, link, "PAYMENT_NOT_FOUND", "missing-association", `Appointment ${link.appointmentId} does not exist.`);
  }

  // 2. Payment lock (always after the appointment's).
  const payment = await lockPayment(tx, link);
  if (!payment) {
    return inconsistentOutcome(
      evidence,
      link,
      "PAYMENT_NOT_FOUND",
      "missing-association",
      `Payment ${link.paymentId} no longer belongs to Appointment ${link.appointmentId}.`,
    );
  }

  const base: PlaceIndependentInput = {
    evidence,
    payment: paymentFacts(payment),
    appointment: {
      status: appointment.status,
      holdExpiresAt: appointment.holdExpiresAt,
      depositAmountCents: appointment.depositAmountCents,
    },
  };

  // 3. Fast path: nothing here can allocate, so the BookingSlot stays unlocked.
  const early = decidePaymentBeforePlace(base);
  switch (early.kind) {
    case "already-allocated":
      return { kind: "already-allocated", ...link };
    case "already-recorded-unallocated":
      return { kind: "already-recorded-unallocated", ...link, reason: early.reason };
    case "not-paid":
      if (early.expirePayment) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: "EXPIRED" } });
      }
      return { kind: "not-paid", ...link, paymentExpired: early.expirePayment };
    case "inconsistent":
      return inconsistentOutcome(evidence, link, early.problem, POLICY_PROBLEM_CATEGORY[early.problem], early.message);
    case "place-required":
      break;
  }

  // A first receipt: the PaymentIntent must not already belong to another Payment.
  const paymentIntentId = (evidence.charge as NonNullable<VerifiedCheckoutEvidence["charge"]>).paymentIntentId;
  const holder = await tx.payment.findFirst({
    where: { providerPaymentIntentId: paymentIntentId, id: { not: payment.id } },
    select: { id: true },
  });
  if (holder) {
    return inconsistentOutcome(
      evidence,
      link,
      "PROVIDER_IDENTITY_IN_USE",
      "identity-conflict",
      `PaymentIntent ${paymentIntentId} is already recorded on Payment ${holder.id}.`,
    );
  }

  // 4. Place facts under the slot lock, at one authoritative instant.
  await lockBookingSlotCapacity(tx, appointment.bookingSlotId);
  const slot = await tx.bookingSlot.findUniqueOrThrow({
    where: { id: appointment.bookingSlotId },
    select: { capacity: true, isActive: true },
  });
  const location = await tx.salonLocation.findUniqueOrThrow({
    where: { id: appointment.locationId },
    select: { id: true, timeZone: true, isActive: true, acceptsOnlineBooking: true },
  });
  const decidedAt = await databaseClock(tx);
  const appointmentDate = salonDateFromDatabase(appointment.appointmentDate);

  let bookingPolicyClosedReason;
  try {
    bookingPolicyClosedReason = placePolicyClosedReason(location, slot, appointmentDate, decidedAt);
  } catch (error) {
    if (!isBookingError(error, "LOCATION_TIME_ZONE_INVALID")) throw error;
    return inconsistentOutcome(evidence, link, "LOCATION_TIME_ZONE_INVALID", "corrupt-local-state", error.message);
  }

  const input: PaymentConfirmationInput = {
    ...base,
    place: {
      capacity: slot.capacity,
      consumedByOthers: await countConsumedCapacity(
        tx,
        { bookingSlotId: appointment.bookingSlotId, appointmentDate },
        decidedAt,
        { excludingAppointmentId: appointment.id },
      ),
      bookingPolicyClosedReason,
    },
    decidedAt,
  };
  const decision = decidePaymentConfirmation(input);
  const event = paymentDecisionEvent(decision, input);

  // 5. Writes. Each statement leaves the Payment CHECK constraints satisfied.
  if (decision.kind === "confirm" && event?.type === "PAYMENT_CONFIRMED") {
    const { receipt } = decision;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        providerCheckoutSessionId: receipt.checkoutSessionId,
        providerPaymentIntentId: receipt.paymentIntentId,
        paidAt: receipt.paidAt,
        allocatedAt: decidedAt,
      },
    });
    await tx.appointment.update({
      where: { id: appointment.id },
      data: { status: decision.transition.to },
    });
    await appendAppointmentEvent(tx, appointment.id, event.type, event.details);
    return { kind: "confirmed", ...link, method: decision.method, allocatedAt: decidedAt, decidedAt };
  }

  if (decision.kind === "reconcile" && event?.type === "PAYMENT_RECEIVED_UNCONFIRMED") {
    const { receipt } = decision;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        providerCheckoutSessionId: receipt.checkoutSessionId,
        providerPaymentIntentId: receipt.paymentIntentId,
        paidAt: receipt.paidAt,
        reconciliationReason: decision.reason,
      },
    });
    await appendAppointmentEvent(tx, appointment.id, event.type, event.details);
    return { kind: "reconciled", ...link, reason: decision.reason, decidedAt };
  }

  // decidePaymentConfirmation repeats the first phase, which already
  // returned "place-required" for these same facts.
  throw new Error(`Payment ${payment.id}: unexpected decision "${decision.kind}" after the place-independent phase.`);
}

async function lockPayment(tx: Prisma.TransactionClient, link: PaymentLink) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Payment"
    WHERE "id" = ${link.paymentId} AND "appointmentId" = ${link.appointmentId}
    FOR UPDATE
  `;
  if (locked.length === 0) return null;
  return tx.payment.findUniqueOrThrow({ where: { id: link.paymentId }, select: paymentFactsSelect });
}

function paymentFacts(row: Prisma.PaymentGetPayload<{ select: typeof paymentFactsSelect }>): PaymentRecordFacts {
  return {
    paymentId: row.id,
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    providerCheckoutSessionId: row.providerCheckoutSessionId,
    providerPaymentIntentId: row.providerPaymentIntentId,
    paidAt: row.paidAt,
    allocatedAt: row.allocatedAt,
    refundedAmountCents: row.refundedAmountCents,
    reconciliationReason: row.reconciliationReason,
  };
}

/**
 * The decision instant: the database clock, read after the last lock, so a
 * transaction that waited for a lock decides at the time it actually holds it.
 */
async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

function isProviderIdentityConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = JSON.stringify(error.meta?.target ?? "");
  return target.includes("providerPaymentIntentId") || target.includes("providerCheckoutSessionId");
}

function inconsistentOutcome(
  evidence: VerifiedCheckoutEvidence | null,
  link: PaymentLink | null,
  problem: FulfillmentProblem,
  category: FulfillmentProblemCategory,
  message: string,
): InconsistentFulfillmentOutcome {
  return {
    kind: "inconsistent",
    category,
    problem,
    message,
    alert: {
      checkoutSessionId: evidence?.checkoutSessionId ?? null,
      paymentIntentId: evidence?.charge?.paymentIntentId ?? null,
      stripeEventId: evidence?.stripeEventId ?? null,
      paymentId: link?.paymentId ?? null,
      appointmentId: link?.appointmentId ?? null,
      // Nothing is written on an inconsistent outcome.
      unrecordedCharge: evidence?.paymentStatus === "paid",
    },
  };
}
