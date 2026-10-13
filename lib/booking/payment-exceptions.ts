import { randomUUID } from "node:crypto";

import type { PaymentExceptionCategory, PaymentExceptionProblem } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  applyVerifiedCheckoutSession,
  type FulfillmentProblem,
  type FulfillmentProblemCategory,
  type InconsistentFulfillmentOutcome,
  type PaymentFulfillmentOutcome,
} from "./payment-fulfillment";
import { isVerifiedCheckoutEvidence, type VerifiedCheckoutEvidence } from "./payment-policy";

/**
 * Durable payment exceptions — verified Stripe evidence that payment
 * fulfillment could not apply (an `inconsistent` outcome) is recorded in
 * PaymentProcessingException so a received charge never disappears.
 *
 * A record is evidence for a human, never a link: nothing here attaches the
 * charge to a Payment, confirms an appointment, touches Payment/Appointment
 * rows, or resolves an exception.
 *
 * Idempotency key: (provider, Checkout Session id, problem). The session is
 * the provider identity present in every verified evidence (paid or not), and
 * a Checkout Session in payment mode has at most one PaymentIntent, which is
 * recorded alongside. Stripe Event ids are kept as first/last references only:
 * a redelivery or a new event about the same session and problem updates the
 * same row. A different problem, or a different session (a genuinely
 * different charge), is a different row.
 *
 * Observation timestamps come from the database clock. The first observation
 * (firstObservedAt, firstStripeEventId, and the first non-null charge facts)
 * is never changed; lastObservedAt, lastStripeEventId and occurrenceCount
 * advance. One INSERT … ON CONFLICT statement, so concurrent recordings of the
 * same exception serialize on the unique index and none is lost.
 *
 * ── Webhook contract (the HTTP adapter itself is a later ticket) ──────────
 *
 *   invalid / missing Stripe signature ........ 400, not retryable, nothing read
 *   evidence applied (confirmed, reconciled,
 *     already-*, not-paid) .................... 200
 *   inconsistent → exception recorded ......... 200 (only AFTER the row commits)
 *   exception recording fails ................. 500, retryable (Stripe redelivers)
 *   any other thrown error (database down,
 *     deadlock, timeout) ...................... 500, retryable
 *
 * The adapter builds evidence only from a Checkout Session it retrieved from
 * Stripe with the secret key (`verifiedCheckoutEvidence`). Browser return
 * URLs, query strings and form posts are lookup hints at most: they are never
 * evidence, so they can never reach `processVerifiedCheckoutEvidence`.
 * An `inconsistent` outcome is acknowledged only by way of a committed
 * exception row — there is no path that acknowledges it without one.
 */

type RecordableProblem = Exclude<FulfillmentProblem, "EVIDENCE_NOT_VERIFIED">;

/** Every recordable problem has a database value (and vice versa, by the enum). */
const PROBLEM: Readonly<Record<RecordableProblem, PaymentExceptionProblem>> = {
  LOCAL_RECORD_INVALID: "LOCAL_RECORD_INVALID",
  ALLOCATED_BUT_APPOINTMENT_PENDING: "ALLOCATED_BUT_APPOINTMENT_PENDING",
  CHECKOUT_SESSION_MISMATCH: "CHECKOUT_SESSION_MISMATCH",
  PAYMENT_INTENT_MISMATCH: "PAYMENT_INTENT_MISMATCH",
  PAID_AT_MISMATCH: "PAID_AT_MISMATCH",
  VERIFIED_AMOUNT_CHANGED: "VERIFIED_AMOUNT_CHANGED",
  LOCAL_PAID_BUT_PROVIDER_UNPAID: "LOCAL_PAID_BUT_PROVIDER_UNPAID",
  NO_PAYMENT_REQUIRED: "NO_PAYMENT_REQUIRED",
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  REFERENCE_MISMATCH: "REFERENCE_MISMATCH",
  PROVIDER_IDENTITY_IN_USE: "PROVIDER_IDENTITY_IN_USE",
  LOCATION_TIME_ZONE_INVALID: "LOCATION_TIME_ZONE_INVALID",
};

const CATEGORY: Readonly<Record<FulfillmentProblemCategory, PaymentExceptionCategory>> = {
  "identity-conflict": "IDENTITY_CONFLICT",
  "corrupt-local-state": "CORRUPT_LOCAL_STATE",
  "missing-association": "MISSING_ASSOCIATION",
  "unusable-evidence": "UNUSABLE_EVIDENCE",
};

export type RecordedPaymentException = {
  id: string;
  /** False when this call updated an existing record (a repeat observation). */
  created: boolean;
  occurrenceCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  resolvedAt: Date | null;
};

/**
 * Records (or re-observes) the exception behind an `inconsistent` outcome.
 *
 * Throws — and writes nothing — when the evidence is not verified, the
 * outcome is not a recordable inconsistency, or the outcome was produced for
 * different evidence. Database failures propagate (the caller retries).
 */
export async function recordPaymentException(
  evidence: VerifiedCheckoutEvidence,
  outcome: InconsistentFulfillmentOutcome,
): Promise<RecordedPaymentException> {
  if (!isVerifiedCheckoutEvidence(evidence)) {
    throw new Error("Payment exceptions are recorded only from verified Checkout evidence.");
  }
  if (outcome?.kind !== "inconsistent" || !Object.hasOwn(PROBLEM, outcome.problem)) {
    throw new Error("Not a recordable payment exception (unverified evidence is never recorded).");
  }
  const charge = evidence.charge;
  if (
    outcome.alert.checkoutSessionId !== evidence.checkoutSessionId ||
    outcome.alert.paymentIntentId !== (charge?.paymentIntentId ?? null) ||
    outcome.alert.stripeEventId !== evidence.stripeEventId
  ) {
    throw new Error("The inconsistent outcome was not produced for this evidence.");
  }

  const problem = PROBLEM[outcome.problem as RecordableProblem];
  const category = CATEGORY[outcome.category];
  const moneyReceived = evidence.paymentStatus === "paid";
  const expectedPaymentId = outcome.alert.paymentId ?? evidence.reference?.paymentId ?? null;
  const expectedAppointmentId = outcome.alert.appointmentId ?? evidence.reference?.appointmentId ?? null;

  // Observation instants: the database clock in UTC (columns are timestamp(3) without zone).
  const [row] = await prisma.$queryRaw<RecordedPaymentException[]>`
    INSERT INTO "PaymentProcessingException" AS e (
      "id", "provider", "checkoutSessionId", "paymentIntentId",
      "expectedPaymentId", "expectedAppointmentId", "category", "problem",
      "moneyReceived", "verifiedAmountCents", "verifiedCurrency",
      "firstStripeEventId", "lastStripeEventId",
      "firstObservedAt", "lastObservedAt", "occurrenceCount"
    ) VALUES (
      ${randomUUID()}, 'STRIPE', ${evidence.checkoutSessionId}, ${charge?.paymentIntentId ?? null},
      ${expectedPaymentId}, ${expectedAppointmentId},
      ${category}::"PaymentExceptionCategory", ${problem}::"PaymentExceptionProblem",
      ${moneyReceived}, ${charge?.amountCents ?? null}::int, ${charge?.currency ?? null},
      ${evidence.stripeEventId}, ${evidence.stripeEventId},
      clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC', 1
    )
    ON CONFLICT ("provider", "checkoutSessionId", "problem") DO UPDATE SET
      "lastObservedAt" = GREATEST(e."lastObservedAt", EXCLUDED."lastObservedAt"),
      "occurrenceCount" = e."occurrenceCount" + 1,
      "lastStripeEventId" = COALESCE(EXCLUDED."lastStripeEventId", e."lastStripeEventId"),
      "moneyReceived" = e."moneyReceived" OR EXCLUDED."moneyReceived",
      -- Charge facts and expected ids: first non-null observation wins.
      "paymentIntentId" = COALESCE(e."paymentIntentId", EXCLUDED."paymentIntentId"),
      "verifiedAmountCents" = CASE WHEN e."verifiedAmountCents" IS NULL
        THEN EXCLUDED."verifiedAmountCents" ELSE e."verifiedAmountCents" END,
      "verifiedCurrency" = CASE WHEN e."verifiedAmountCents" IS NULL
        THEN EXCLUDED."verifiedCurrency" ELSE e."verifiedCurrency" END,
      "expectedPaymentId" = COALESCE(e."expectedPaymentId", EXCLUDED."expectedPaymentId"),
      "expectedAppointmentId" = COALESCE(e."expectedAppointmentId", EXCLUDED."expectedAppointmentId")
    RETURNING "id", (xmax = 0) AS "created", "occurrenceCount",
              "firstObservedAt", "lastObservedAt", "resolvedAt"
  `;
  return row;
}

export type CheckoutEvidenceDisposition =
  | { kind: "applied"; outcome: Exclude<PaymentFulfillmentOutcome, { kind: "inconsistent" }> }
  | { kind: "exception-recorded"; outcome: InconsistentFulfillmentOutcome; exception: RecordedPaymentException };

/**
 * What a webhook (or return-page check) does with verified evidence: apply it,
 * and when it cannot be applied, record the exception durably. Resolves only
 * when the evidence is fully accounted for; anything thrown means "retry".
 */
export async function processVerifiedCheckoutEvidence(
  evidence: VerifiedCheckoutEvidence,
): Promise<CheckoutEvidenceDisposition> {
  const outcome = await applyVerifiedCheckoutSession(evidence);
  if (outcome.kind !== "inconsistent") return { kind: "applied", outcome };
  // Fulfillment wrote nothing; record in a separate statement. If this
  // throws, the caller must not acknowledge.
  const exception = await recordPaymentException(evidence, outcome);
  return { kind: "exception-recorded", outcome, exception };
}

export type CheckoutWebhookResponse =
  | { status: 200 }
  | { status: 400; retryable: false }
  | { status: 500; retryable: true };

/** The webhook contract above as a function, for the future HTTP adapter. */
export function checkoutWebhookResponse(
  result:
    | { signature: "invalid" }
    | { disposition: CheckoutEvidenceDisposition }
    | { error: unknown },
): CheckoutWebhookResponse {
  if ("signature" in result) return { status: 400, retryable: false };
  if ("error" in result) return { status: 500, retryable: true };
  return { status: 200 };
}

/**
 * Exceptions needing attention, oldest first: never resolved, or observed
 * again after being resolved.
 */
export function listUnresolvedPaymentExceptions() {
  const exceptions = prisma.paymentProcessingException;
  return exceptions.findMany({
    where: {
      OR: [{ resolvedAt: null }, { resolvedAt: { lt: exceptions.fields.lastObservedAt } }],
    },
    orderBy: [{ firstObservedAt: "asc" }, { id: "asc" }],
  });
}
