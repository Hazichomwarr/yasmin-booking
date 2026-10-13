import type { AppointmentStatus, PaymentReconciliationReason, PaymentStatus } from "@prisma/client";

import {
  eventDetails,
  type PaymentConfirmationMethod,
  type PaymentConfirmedEventDetails,
  type PaymentReceivedUnconfirmedEventDetails,
} from "./appointment-events";
import type { PlacePolicyClosedReason } from "./booking-policy";
import { consumesCapacity, remainingCapacity } from "./capacity";
import { PAYMENT_CONFIRMATION_TRANSITION } from "./lifecycle-policy";

/**
 * THE payment confirmation policy — decides what a verified Stripe Checkout
 * result means for one Payment and its Appointment.
 *
 * Pure and deterministic: no database, no Stripe, no clock. The caller (the
 * payment fulfillment service, YASMIN-1E.3) gathers the facts inside one
 * transaction — Appointment lock → Payment lock → BookingSlot lock, then the
 * authoritative instant — and applies the decision in that same transaction.
 *
 * Evidence: only a VerifiedCheckoutEvidence built from a Checkout Session the
 * server retrieved from Stripe with its secret key. A browser redirect or a
 * user-supplied session_id is a lookup key, never proof of payment.
 *
 * A received charge is never discarded and never marked FAILED: it is either
 * allocated (the appointment is confirmed) or recorded with a reconciliation
 * reason. Nothing here refunds, and nothing confirms past capacity.
 *
 * Confirmation requires, in order:
 *   1. verified paid Checkout Session;
 *   2. verified amount and currency equal to the Payment record (whose amount
 *      equals the Appointment's deposit snapshot);
 *   3. no refund activity on the charge;
 *   4. appointment PENDING_PAYMENT;
 *   5. a free place: consumedByOthers < capacity on the appointment's
 *      (slot, date), counted under the slot lock — ALWAYS, even inside an
 *      active hold, so no clock disagreement can overbook;
 *   6. hold active at the decision instant (existing booking terms kept), OR
 *      hold expired and the current location/date/slot policy is open
 *      (full reacquisition).
 *
 * Idempotency: a Payment that already received money is never re-decided.
 * Already allocated → no-op. Received but unallocated (an open or closed
 * reconciliation case) → no-op; retrying allocation is a separate, explicit
 * reconciliation operation, never a side effect of a duplicate webhook.
 * Duplicate deliveries are recognised by persisted provider identities, not
 * by Stripe Event IDs. Conflicting identities are reported, never replaced.
 */

declare const verifiedEvidenceBrand: unique symbol;

export type CheckoutSessionStatus = "open" | "complete" | "expired";
export type CheckoutPaymentStatus = "paid" | "unpaid" | "no_payment_required";

/** The successful charge behind a paid Checkout Session. */
export type VerifiedCharge = {
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  /** When Stripe created the successful charge. */
  paidAt: Date;
  /** Refunded or being refunded on the charge (succeeded + pending + requires_action). */
  refundedOrPendingCents: number;
};

/**
 * A Checkout Session as retrieved from the Stripe API. Constructible only via
 * `verifiedCheckoutEvidence`, which validates and normalizes it.
 */
export type VerifiedCheckoutEvidence = {
  readonly checkoutSessionId: string;
  readonly sessionStatus: CheckoutSessionStatus;
  readonly paymentStatus: CheckoutPaymentStatus;
  /** Present exactly when paymentStatus is "paid". */
  readonly charge: Readonly<VerifiedCharge> | null;
  /** The webhook event that triggered verification; null for return-page or sweep checks. */
  readonly stripeEventId: string | null;
  readonly [verifiedEvidenceBrand]: true;
};

export type CheckoutEvidenceInput = {
  checkoutSessionId: string;
  sessionStatus: string;
  paymentStatus: string;
  paymentIntentId?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  paidAt?: Date | null;
  refundedOrPendingCents?: number | null;
  stripeEventId?: string | null;
};

const SESSION_STATUSES: ReadonlySet<string> = new Set<CheckoutSessionStatus>(["open", "complete", "expired"]);
const PAYMENT_STATUSES: ReadonlySet<string> = new Set<CheckoutPaymentStatus>([
  "paid",
  "unpaid",
  "no_payment_required",
]);

/**
 * Validates and normalizes facts read from a Stripe-retrieved Checkout
 * Session. Throws on anything unusable: malformed provider data is an
 * unexpected failure, not a business outcome.
 */
export function verifiedCheckoutEvidence(input: CheckoutEvidenceInput): VerifiedCheckoutEvidence {
  const fail = (problem: string): never => {
    throw new Error(`Unusable Stripe checkout evidence: ${problem}.`);
  };

  if (!/^cs_\S+$/.test(input.checkoutSessionId)) fail("checkoutSessionId is not a Checkout Session id");
  if (!SESSION_STATUSES.has(input.sessionStatus)) fail(`unknown session status "${input.sessionStatus}"`);
  if (!PAYMENT_STATUSES.has(input.paymentStatus)) fail(`unknown payment status "${input.paymentStatus}"`);
  const stripeEventId = input.stripeEventId ?? null;
  if (stripeEventId !== null && !/^evt_\S+$/.test(stripeEventId)) fail("stripeEventId is not an Event id");

  let charge: VerifiedCharge | null = null;
  if (input.paymentStatus === "paid") {
    if (input.sessionStatus !== "complete") fail("a paid session must be complete");
    const { paymentIntentId, amountCents, currency, paidAt } = input;
    const refunded = input.refundedOrPendingCents ?? 0;
    if (!paymentIntentId || !/^pi_\S+$/.test(paymentIntentId)) fail("paid session without a PaymentIntent id");
    if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0) fail("amount must be a positive integer");
    if (!currency || !/^[a-z]{3}$/.test(currency)) fail("currency must be a lowercase ISO code");
    if (!(paidAt instanceof Date) || Number.isNaN(paidAt.getTime())) fail("paidAt must be a valid Date");
    if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > (amountCents as number)) {
      fail("refunded amount must be within 0..amount");
    }
    charge = Object.freeze({
      paymentIntentId: paymentIntentId as string,
      amountCents: amountCents as number,
      currency: currency as string,
      paidAt: new Date((paidAt as Date).getTime()),
      refundedOrPendingCents: refunded,
    });
  }

  return Object.freeze({
    checkoutSessionId: input.checkoutSessionId,
    sessionStatus: input.sessionStatus as CheckoutSessionStatus,
    paymentStatus: input.paymentStatus as CheckoutPaymentStatus,
    charge,
    stripeEventId,
  }) as VerifiedCheckoutEvidence;
}

/** The persisted Payment, as read under its row lock. */
export type PaymentRecordFacts = {
  paymentId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  providerCheckoutSessionId: string | null;
  providerPaymentIntentId: string | null;
  paidAt: Date | null;
  allocatedAt: Date | null;
  refundedAmountCents: number;
  reconciliationReason: PaymentReconciliationReason | null;
};

/** The Appointment, as read under its row lock. */
export type AppointmentPaymentFacts = {
  status: AppointmentStatus;
  holdExpiresAt: Date | null;
  depositAmountCents: number;
};

/** The appointment's own (slot, date), evaluated under the slot lock at `decidedAt`. */
export type PlaceFacts = {
  capacity: number;
  /** Capacity-consuming appointments at `decidedAt`, excluding this one. */
  consumedByOthers: number;
  /** Current location/date/slot policy; consulted only when the hold has expired. */
  bookingPolicyClosedReason: PlacePolicyClosedReason | null;
};

export type PaymentConfirmationInput = {
  evidence: VerifiedCheckoutEvidence;
  payment: PaymentRecordFacts;
  appointment: AppointmentPaymentFacts;
  place: PlaceFacts;
  /** The transaction's authoritative instant, read after the last lock. */
  decidedAt: Date;
};

/** What to record on the Payment when money is received. */
export type PaymentReceipt = {
  checkoutSessionId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
  previousStatus: PaymentStatus;
};

export type PlaceAssessment = {
  holdExpiresAt: Date | null;
  holdActive: boolean;
  capacity: number;
  consumedByOthers: number;
  /** The policy reason that blocked reacquisition, if any. */
  bookingPolicyClosedReason: PlacePolicyClosedReason | null;
};

export type PaymentInconsistency =
  /** The Payment record or its link to the appointment violates the payment invariants. */
  | "LOCAL_RECORD_INVALID"
  /** The Payment is allocated but the appointment never left PENDING_PAYMENT. */
  | "ALLOCATED_BUT_APPOINTMENT_PENDING"
  | "CHECKOUT_SESSION_MISMATCH"
  | "PAYMENT_INTENT_MISMATCH"
  /** Stripe's charge time differs from the recorded paidAt: a different charge. */
  | "PAID_AT_MISMATCH"
  /** An allocated charge's verified amount/currency no longer matches. */
  | "VERIFIED_AMOUNT_CHANGED"
  /** Stripe reports no payment for a Payment recorded as received. */
  | "LOCAL_PAID_BUT_PROVIDER_UNPAID"
  /** Deposit sessions always require payment. */
  | "NO_PAYMENT_REQUIRED";

export type PaymentConfirmationDecision =
  | {
      kind: "confirm";
      method: PaymentConfirmationMethod;
      receipt: PaymentReceipt;
      place: PlaceAssessment;
      transition: typeof PAYMENT_CONFIRMATION_TRANSITION;
    }
  | { kind: "reconcile"; reason: PaymentReconciliationReason; receipt: PaymentReceipt; place: PlaceAssessment }
  | { kind: "already-allocated" }
  | { kind: "already-recorded-unallocated"; reason: PaymentReconciliationReason }
  /** No money received. `expirePayment`: Stripe says the session expired and the Payment is still PENDING. */
  | { kind: "not-paid"; expirePayment: boolean }
  /** Nothing may be written; the caller must surface this for investigation. */
  | { kind: "inconsistent"; problem: PaymentInconsistency; message: string };

const RECEIVED_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["PAID", "REFUNDED"]);

export function decidePaymentConfirmation(input: PaymentConfirmationInput): PaymentConfirmationDecision {
  const { evidence, payment, appointment, place, decidedAt } = input;
  assertPlaceFacts(place, decidedAt);

  const localProblem = localRecordProblem(payment, appointment);
  if (localProblem) return inconsistent("LOCAL_RECORD_INVALID", localProblem);

  if (payment.allocatedAt !== null && appointment.status === "PENDING_PAYMENT") {
    return inconsistent(
      "ALLOCATED_BUT_APPOINTMENT_PENDING",
      `Payment ${payment.paymentId} is allocated but its appointment is still PENDING_PAYMENT.`,
    );
  }

  if (
    payment.providerCheckoutSessionId !== null &&
    payment.providerCheckoutSessionId !== evidence.checkoutSessionId
  ) {
    return inconsistent(
      "CHECKOUT_SESSION_MISMATCH",
      `Payment ${payment.paymentId} is bound to a different Checkout Session.`,
    );
  }

  const received = RECEIVED_STATUSES.has(payment.status);

  if (evidence.paymentStatus === "no_payment_required") {
    return inconsistent("NO_PAYMENT_REQUIRED", `Checkout Session for Payment ${payment.paymentId} required no payment.`);
  }

  if (evidence.paymentStatus === "unpaid") {
    if (received) {
      return inconsistent(
        "LOCAL_PAID_BUT_PROVIDER_UNPAID",
        `Payment ${payment.paymentId} is recorded as received but Stripe reports it unpaid.`,
      );
    }
    return { kind: "not-paid", expirePayment: evidence.sessionStatus === "expired" && payment.status === "PENDING" };
  }

  // paymentStatus === "paid": a verified successful charge.
  const charge = evidence.charge as VerifiedCharge;

  if (payment.providerPaymentIntentId !== null && payment.providerPaymentIntentId !== charge.paymentIntentId) {
    return inconsistent("PAYMENT_INTENT_MISMATCH", `Payment ${payment.paymentId} is bound to a different PaymentIntent.`);
  }

  if (received) {
    if ((payment.paidAt as Date).getTime() !== charge.paidAt.getTime()) {
      return inconsistent("PAID_AT_MISMATCH", `Payment ${payment.paymentId} has a different recorded charge time.`);
    }
    if (payment.allocatedAt !== null) {
      if (!amountMatches(charge, payment)) {
        return inconsistent(
          "VERIFIED_AMOUNT_CHANGED",
          `Allocated Payment ${payment.paymentId} no longer matches its verified amount.`,
        );
      }
      return { kind: "already-allocated" };
    }
    return {
      kind: "already-recorded-unallocated",
      reason: payment.reconciliationReason as PaymentReconciliationReason,
    };
  }

  // First receipt of this charge (also when the Payment was FAILED or EXPIRED:
  // Stripe's verified success overrides the local guess).
  const receipt: PaymentReceipt = {
    checkoutSessionId: evidence.checkoutSessionId,
    paymentIntentId: charge.paymentIntentId,
    amountCents: charge.amountCents,
    currency: charge.currency,
    paidAt: new Date(charge.paidAt.getTime()),
    previousStatus: payment.status,
  };
  const holdActive = consumesCapacity(
    { status: "PENDING_PAYMENT", holdExpiresAt: appointment.holdExpiresAt },
    decidedAt,
  );
  const assessment = (bookingPolicyClosedReason: PlacePolicyClosedReason | null): PlaceAssessment => ({
    holdExpiresAt: appointment.holdExpiresAt === null ? null : new Date(appointment.holdExpiresAt.getTime()),
    holdActive,
    capacity: place.capacity,
    consumedByOthers: place.consumedByOthers,
    bookingPolicyClosedReason,
  });
  const reconcile = (
    reason: PaymentReconciliationReason,
    policyReason: PlacePolicyClosedReason | null = null,
  ): PaymentConfirmationDecision => ({ kind: "reconcile", reason, receipt, place: assessment(policyReason) });

  if (!amountMatches(charge, payment)) return reconcile("AMOUNT_MISMATCH");
  if (charge.refundedOrPendingCents > 0) return reconcile("REFUNDED_BEFORE_ALLOCATION");
  if (appointment.status !== PAYMENT_CONFIRMATION_TRANSITION.from) return reconcile("APPOINTMENT_NOT_PAYABLE");

  const placeFree = remainingCapacity(place.capacity, place.consumedByOthers) > 0;

  if (holdActive) {
    // Existing booking terms are kept, but capacity is never bypassed.
    if (!placeFree) return reconcile("PLACE_UNAVAILABLE");
    return confirm("within-active-hold", receipt, assessment(null));
  }

  // Expired hold: full reacquisition eligibility.
  if (place.bookingPolicyClosedReason !== null) {
    return reconcile("PLACE_UNAVAILABLE", place.bookingPolicyClosedReason);
  }
  if (!placeFree) return reconcile("PLACE_UNAVAILABLE");
  return confirm("reacquired-after-hold-expiry", receipt, assessment(null));
}

function confirm(
  method: PaymentConfirmationMethod,
  receipt: PaymentReceipt,
  place: PlaceAssessment,
): PaymentConfirmationDecision {
  return { kind: "confirm", method, receipt, place, transition: PAYMENT_CONFIRMATION_TRANSITION };
}

function inconsistent(problem: PaymentInconsistency, message: string): PaymentConfirmationDecision {
  return { kind: "inconsistent", problem, message };
}

function amountMatches(charge: VerifiedCharge, payment: PaymentRecordFacts): boolean {
  return charge.amountCents === payment.amountCents && charge.currency === payment.currency;
}

/** Mirrors the migration #3 invariants plus the Payment ↔ deposit-snapshot link. */
function localRecordProblem(payment: PaymentRecordFacts, appointment: AppointmentPaymentFacts): string | null {
  const received = RECEIVED_STATUSES.has(payment.status);
  if (payment.amountCents !== appointment.depositAmountCents) {
    return `Payment ${payment.paymentId} amount differs from the appointment's deposit snapshot.`;
  }
  if (received !== (payment.paidAt !== null)) {
    return `Payment ${payment.paymentId} status ${payment.status} disagrees with paidAt.`;
  }
  if (received && payment.providerPaymentIntentId === null) {
    return `Received Payment ${payment.paymentId} has no PaymentIntent.`;
  }
  if (payment.allocatedAt !== null && !received) {
    return `Payment ${payment.paymentId} is allocated without a received charge.`;
  }
  if (received && payment.allocatedAt === null && payment.reconciliationReason === null) {
    return `Received Payment ${payment.paymentId} is neither allocated nor in reconciliation.`;
  }
  if (!received && (payment.reconciliationReason !== null || payment.refundedAmountCents !== 0)) {
    return `Payment ${payment.paymentId} has reconciliation or refund facts without a received charge.`;
  }
  return null;
}

function assertPlaceFacts(place: PlaceFacts, decidedAt: Date): void {
  if (!(decidedAt instanceof Date) || Number.isNaN(decidedAt.getTime())) {
    throw new Error("decidedAt must be a valid Date.");
  }
  for (const [label, value] of [
    ["capacity", place.capacity],
    ["consumedByOthers", place.consumedByOthers],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`place.${label} must be a non-negative integer.`);
  }
}

/**
 * The audit event a decision requires, built from the decision and its
 * inputs. `allocatedAt` is the decision instant. Decisions that change
 * nothing on the appointment return null.
 */
export function paymentDecisionEvent(
  decision: PaymentConfirmationDecision,
  input: PaymentConfirmationInput,
):
  | { type: "PAYMENT_CONFIRMED"; details: PaymentConfirmedEventDetails }
  | { type: "PAYMENT_RECEIVED_UNCONFIRMED"; details: PaymentReceivedUnconfirmedEventDetails }
  | null {
  if (decision.kind !== "confirm" && decision.kind !== "reconcile") return null;

  const payment = {
    paymentId: input.payment.paymentId,
    checkoutSessionId: decision.receipt.checkoutSessionId,
    paymentIntentId: decision.receipt.paymentIntentId,
    amountCents: decision.receipt.amountCents,
    currency: decision.receipt.currency,
    paidAt: decision.receipt.paidAt,
  };
  const hold = { expiresAt: decision.place.holdExpiresAt, activeAtDecision: decision.place.holdActive };
  const capacity = { configured: decision.place.capacity, consumedByOthers: decision.place.consumedByOthers };

  if (decision.kind === "confirm") {
    return {
      type: decision.transition.event,
      details: eventDetails.paymentConfirmed({
        payment,
        allocatedAt: input.decidedAt,
        confirmation: decision.method,
        hold,
        capacity,
        decidedAt: input.decidedAt,
        stripeEventId: input.evidence.stripeEventId,
      }),
    };
  }
  return {
    type: "PAYMENT_RECEIVED_UNCONFIRMED",
    details: eventDetails.paymentReceivedUnconfirmed({
      payment,
      recorded: { amountCents: input.payment.amountCents, currency: input.payment.currency },
      previousPaymentStatus: decision.receipt.previousStatus,
      reason: decision.reason,
      appointmentStatus: input.appointment.status,
      hold,
      capacity,
      bookingPolicyClosedReason: decision.place.bookingPolicyClosedReason,
      decidedAt: input.decidedAt,
      stripeEventId: input.evidence.stripeEventId,
    }),
  };
}
