import type { AppointmentStatus, PaymentStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { databaseAccessClock, resolveBookingAccess, type BookingAccessClock, type BookingAccessGrant } from "./access";
import { MIN_ORIGINAL_HOLD_MS } from "./checkout";
import { formatSalonAddress, salonAddressSelect } from "./location-address";
import { salonDateFromDatabase, type SalonDate } from "./salon-calendar";

/**
 * Customer-facing booking status (YASMIN-1F.4).
 *
 * The opaque access token alone selects the booking. The response is an
 * explicit allow-list built from booking-time snapshots (what the customer
 * booked), never from current configuration, and never carries customer
 * PII, internal or provider identifiers, events, notes or reconciliation
 * details. Read-only: no locks, no writes.
 */

export type PublicBookingState =
  | "awaiting-payment"
  | "payment-in-progress"
  | "confirmed"
  | "expired"
  | "cancelled"
  | "needs-attention"
  | "closed";

/** The facts the state is derived from. Payment is the booking's deposit attempt, if any. */
export type BookingStatusFacts = {
  appointmentStatus: AppointmentStatus;
  holdExpiresAt: Date | null;
  payment: {
    status: PaymentStatus;
    /** A Stripe Session is recorded. Existence alone never means paid. */
    hasCheckoutSession: boolean;
    /** Money was received (paidAt set). */
    received: boolean;
    /** The charge confirmed this booking (allocatedAt set). */
    allocated: boolean;
  } | null;
  /**
   * Verified Stripe evidence naming this booking could not be applied and is
   * not resolved (PaymentProcessingException). Its details are never shown;
   * it makes an unfinished booking needs-attention and blocks leaving it behind.
   */
  unresolvedPaymentException: boolean;
};

export type DerivedBookingState = { state: PublicBookingState; canStartCheckout: boolean };

/**
 * Precedence (first match wins):
 *   1. CONFIRMED → confirmed;  COMPLETED / NO_SHOW → closed.
 *   2. Money received but not allocated (and not fully refunded), or an
 *      unresolved payment exception naming the booking → needs-attention,
 *      even on a cancelled or expired booking: a person must resolve it.
 *   3. CANCELLED → cancelled.
 *   4. PENDING_PAYMENT with a deposit attempt:
 *      - allocated (inconsistent with PENDING_PAYMENT) → needs-attention;
 *      - PENDING with a Session → payment-in-progress, whatever the hold says:
 *        the customer may have paid and fulfillment has not reported yet;
 *      - PENDING without a recorded Session → needs-attention: Session
 *        creation's outcome is unknown (never re-derived from elapsed time);
 *      - EXPIRED / FAILED / REFUNDED → expired (no new attempt is possible).
 *   5. PENDING_PAYMENT without an attempt: active hold → awaiting-payment
 *      (Checkout startable only with at least MIN_ORIGINAL_HOLD_MS left),
 *      otherwise expired.
 */
export function derivePublicBookingState(facts: BookingStatusFacts, now: Date): DerivedBookingState {
  const settled = (state: PublicBookingState): DerivedBookingState => ({ state, canStartCheckout: false });
  const { appointmentStatus: status, payment } = facts;

  if (status === "CONFIRMED") return settled("confirmed");
  if (status === "COMPLETED" || status === "NO_SHOW") return settled("closed");
  if (payment && payment.received && !payment.allocated && payment.status === "PAID") return settled("needs-attention");
  if (facts.unresolvedPaymentException) return settled("needs-attention");
  if (status === "CANCELLED") return settled("cancelled");

  if (payment) {
    if (payment.allocated) return settled("needs-attention");
    switch (payment.status) {
      case "PENDING":
        return settled(payment.hasCheckoutSession ? "payment-in-progress" : "needs-attention");
      case "PAID":
        // Received + allocated or received + unallocated are handled above.
        return settled("needs-attention");
      case "EXPIRED":
      case "FAILED":
      case "REFUNDED":
        return settled("expired");
    }
  }

  const remainingMs = facts.holdExpiresAt ? facts.holdExpiresAt.getTime() - now.getTime() : 0;
  if (remainingMs > 0) return { state: "awaiting-payment", canStartCheckout: remainingMs >= MIN_ORIGINAL_HOLD_MS };
  return settled("expired");
}

/**
 * May a browser leave this booking behind to start a new one (cookie
 * replacement)? Only when it is demonstrably finished with money: no Payment
 * that is pending (open, completed-awaiting-fulfillment, or of uncertain
 * creation), no received-but-unallocated charge, no unresolved payment
 * exception — and then only if the booking is terminal, or its unpaid hold
 * has fully expired, or its one attempt ended without money. Time remaining
 * on a hold never makes a booking safe to abandon.
 */
export function isSafeToLeaveBehind(facts: BookingStatusFacts, now: Date): boolean {
  const { payment } = facts;
  if (facts.unresolvedPaymentException) return false;
  if (payment) {
    if (payment.status === "PENDING") return false;
    if (payment.status === "PAID" && !payment.allocated) return false;
    if (payment.allocated && facts.appointmentStatus === "PENDING_PAYMENT") return false;
  }
  switch (facts.appointmentStatus) {
    case "CONFIRMED":
    case "COMPLETED":
    case "NO_SHOW":
    case "CANCELLED":
      return true;
    case "PENDING_PAYMENT":
      if (payment) return payment.status === "EXPIRED" || payment.status === "FAILED" || payment.status === "REFUNDED";
      return facts.holdExpiresAt === null || facts.holdExpiresAt.getTime() <= now.getTime();
  }
}

/** The complete public status DTO. Adding a field is a deliberate privacy decision. */
export type PublicBookingStatus = {
  state: PublicBookingState;
  canStartCheckout: boolean;
  /** Only while the hold matters to the customer (awaiting or in-progress payment). */
  holdExpiresAt: Date | null;
  locationName: string;
  /** The location's currently configured street address (public salon facts only); null when none. */
  locationAddress: string | null;
  appointmentDate: SalonDate;
  slotTime: string;
  hairstyleName: string | null;
  /** Booking-time variant snapshot; null for simple or legacy services. */
  hairstyleVariantName: string | null;
  totalPriceCents: number;
  depositAmountCents: number;
  balanceDueCents: number;
  /** The deposit was received AND applied to this booking. */
  depositPaid: boolean;
};

/**
 * Status of the booking the token grants access to. Throws
 * BookingAccessError (MALFORMED, UNKNOWN, EXPIRED, REVOKED) like every
 * access-checked operation; one database instant is used throughout.
 */
export async function getAuthorizedBookingStatus(
  accessToken: unknown,
  options: { clock?: BookingAccessClock } = {},
): Promise<PublicBookingStatus> {
  const { now, facts, row } = await readAuthorizedBooking(accessToken, options.clock);
  const { state, canStartCheckout } = derivePublicBookingState(facts, now);

  return {
    state,
    canStartCheckout,
    holdExpiresAt: state === "awaiting-payment" || state === "payment-in-progress" ? row.holdExpiresAt : null,
    locationName: row.locationNameSnapshot,
    locationAddress: formatSalonAddress(row.location),
    appointmentDate: salonDateFromDatabase(row.appointmentDate),
    slotTime: row.slotTimeSnapshot,
    hairstyleName: row.hairstyleNameSnapshot,
    hairstyleVariantName: row.hairstyleVariantNameSnapshot,
    totalPriceCents: row.totalPriceCents,
    depositAmountCents: row.depositAmountCents,
    balanceDueCents: row.balanceDueCents,
    depositPaid: facts.payment?.allocated ?? false,
  };
}

/**
 * Internal: whether the token's booking is safe to leave behind
 * (`isSafeToLeaveBehind`). Throws BookingAccessError for an unusable token,
 * which callers treat as "no booking to protect". Read-only.
 */
export async function isAuthorizedBookingSafeToLeave(
  accessToken: unknown,
  options: { clock?: BookingAccessClock } = {},
): Promise<boolean> {
  const { now, facts } = await readAuthorizedBooking(accessToken, options.clock);
  return isSafeToLeaveBehind(facts, now);
}

async function readAuthorizedBooking(accessToken: unknown, clock: BookingAccessClock = databaseAccessClock) {
  const now = await clock.now();
  const grant: BookingAccessGrant = await resolveBookingAccess(accessToken, { clock: { now: async () => now } });

  const row = await prisma.appointment.findUniqueOrThrow({
    where: { id: grant.appointmentId },
    select: {
      status: true,
      holdExpiresAt: true,
      locationNameSnapshot: true,
      location: { select: salonAddressSelect },
      appointmentDate: true,
      slotTimeSnapshot: true,
      hairstyleNameSnapshot: true,
      hairstyleVariantNameSnapshot: true,
      totalPriceCents: true,
      depositAmountCents: true,
      balanceDueCents: true,
      payments: {
        where: { purpose: "BOOKING_DEPOSIT" },
        select: { status: true, providerCheckoutSessionId: true, paidAt: true, allocatedAt: true },
      },
    },
  });
  // Unresolved = never resolved, or observed again after being resolved.
  const [{ unresolved }] = await prisma.$queryRaw<{ unresolved: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "PaymentProcessingException"
      WHERE "expectedAppointmentId" = ${grant.appointmentId}
        AND ("resolvedAt" IS NULL OR "lastObservedAt" > "resolvedAt")
    ) AS unresolved
  `;

  const deposit = row.payments[0] ?? null;
  const facts: BookingStatusFacts = {
    appointmentStatus: row.status,
    holdExpiresAt: row.holdExpiresAt,
    payment: deposit && {
      status: deposit.status,
      hasCheckoutSession: deposit.providerCheckoutSessionId !== null,
      received: deposit.paidAt !== null,
      allocated: deposit.allocatedAt !== null,
    },
    unresolvedPaymentException: unresolved,
  };
  return { now, facts, row };
}
