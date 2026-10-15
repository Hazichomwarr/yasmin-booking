import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";
import { stripeCheckoutAdapter } from "@/lib/stripe/checkout";
import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, eventDetails } from "./appointment-events";
import { assertBookingAccessUnderLock, resolveBookingAccess, type BookingAccessGrant } from "./access";
import { lockAppointment } from "./appointments";
import { dateClosedReason, locationClosedReason, slotClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity, remainingCapacity } from "./capacity";
import { BookingError } from "./errors";
import { salonDateFromDatabase } from "./salon-calendar";

/** Least original hold time that must remain to start Checkout. */
export const MIN_ORIGINAL_HOLD_MS = 60_000;
const CHECKOUT_WINDOW_MS = 34 * 60_000;
const HOLD_GRACE_MS = 5 * 60_000;
const MIN_PROVIDER_CREATE_WINDOW_MS = 31 * 60_000;
const RECOVERY_LEASE_MS = 30_000;

export type CheckoutStartResult =
  | { kind: "ready"; paymentId: string; checkoutUrl: string; expiresAt: Date }
  | { kind: "ambiguous"; paymentId: string; reason: CheckoutAmbiguityReason; retryable: boolean }
  | { kind: "retry-window-expired"; paymentId: string };

/**
 * Why no Checkout URL could be returned safely. The one-Payment rule holds in
 * every case: a retry can only ever return the recorded Session, never create
 * another, and nothing here asks Stripe to create one again.
 *
 * Each reason is derived from the persisted Payment (plus, for a recorded
 * Session, Stripe's view of it), never from elapsed time, so repeated requests
 * for the same unresolved Payment get the same answer. Only a failed read of
 * an already recorded Session is `retryable`.
 */
export type CheckoutAmbiguityReason =
  /** Stripe could not be reached to re-read the recorded Session. Temporary: retrying is safe and may succeed. */
  | "provider-retrieval-failed"
  /**
   * The Payment has no recorded Session: creation failed, timed out, returned
   * mismatching facts, was not persisted, or is still in flight in another
   * request. A Session may exist at Stripe; its outcome is unknown. Permanent
   * for this booking until payment evidence resolves the Payment.
   */
  | "checkout-creation-unconfirmed"
  /** The recorded Session is expired, past its expiry, of unknown state, or inconsistent with the Payment. */
  | "provider-session-unusable"
  /** Stripe reports the recorded Session complete; verified fulfillment has not been applied yet. */
  | "payment-awaiting-confirmation"
  /** Money was already received for this Payment (PAID or REFUNDED) while the booking still awaits payment. */
  | "payment-already-received"
  /** The attempt ended with no money and no payable Session (EXPIRED/FAILED, from verified Stripe evidence). */
  | "checkout-attempt-ended"
  /** The booking or payment changed (cancelled, revoked, fulfilled) while Checkout was being prepared. */
  | "booking-changed";

const ambiguous = (paymentId: string, reason: CheckoutAmbiguityReason): CheckoutStartResult => ({
  kind: "ambiguous",
  paymentId,
  reason,
  retryable: reason === "provider-retrieval-failed",
});

export interface CheckoutClock {
  now(tx?: Prisma.TransactionClient): Promise<Date>;
}

export const postgresCheckoutClock: CheckoutClock = {
  async now(tx) {
    const client = tx ?? prisma;
    const [{ now }] = await client.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return now;
  },
};

type PreparedCheckout = { paymentId: string; appointmentId: string; amountCents: number; currency: "usd"; expiresAt: Date; leaseToken: string };

/**
 * Internal-only payment adapter. A future authenticated customer boundary must
 * prove ownership of the pending hold before calling this service.
 */
export async function startBookingDepositCheckout(
  appointmentId: string,
  adapter: StripeCheckoutAdapter,
  clock: CheckoutClock = postgresCheckoutClock,
  grant?: BookingAccessGrant,
): Promise<CheckoutStartResult> {
  const prepared = await prepareCheckout(appointmentId, clock, grant);
  if (prepared.kind === "existing") {
    let session;
    try { session = await adapter.retrieveDepositCheckout(prepared.checkoutSessionId); } catch { return ambiguous(prepared.paymentId, "provider-retrieval-failed"); }
    if (!sessionMatchesPayment(session, prepared)) return ambiguous(prepared.paymentId, "provider-session-unusable");
    if (session.status === "complete") return ambiguous(prepared.paymentId, "payment-awaiting-confirmation");
    if (session.status !== "open" || session.expiresAt.getTime() <= (await clock.now()).getTime()) return ambiguous(prepared.paymentId, "provider-session-unusable");
    if (!await canReturnExistingSession(prepared, session.id, clock, grant)) return ambiguous(prepared.paymentId, "booking-changed");
    return { kind: "ready", paymentId: prepared.paymentId, checkoutUrl: session.url, expiresAt: session.expiresAt };
  }
  if (prepared.kind !== "prepared" && prepared.kind !== "recovery") return prepared as CheckoutStartResult;
  const checkout = prepared.checkout;

  if (checkout.expiresAt.getTime() - (await clock.now()).getTime() < MIN_PROVIDER_CREATE_WINDOW_MS) {
    return { kind: "retry-window-expired", paymentId: checkout.paymentId };
  }

  let session;
  try {
    session = await adapter.createDepositCheckout(checkout);
  } catch {
    // The provider may have accepted the idempotent request. Do not create a
    // different attempt or shorten the hold without proof that no session exists.
    return ambiguous(checkout.paymentId, "checkout-creation-unconfirmed");
  }

  if (!sessionMatchesPayment(session, checkout)) {
    // Nothing is persisted, so later requests see the same unrecorded Payment.
    return ambiguous(checkout.paymentId, "checkout-creation-unconfirmed");
  }
  await adapter.afterCreateBeforePersistence?.(session, checkout);

  let persisted: boolean;
  try {
    persisted = await prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, checkout.appointmentId);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payment" WHERE "id" = ${checkout.paymentId} FOR UPDATE
    `;
    if (locked.length === 0) throw new Error("Prepared Payment disappeared before Checkout Session persistence.");
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: checkout.paymentId }, select: { providerCheckoutSessionId: true, status: true } });
    if (payment.providerCheckoutSessionId && payment.providerCheckoutSessionId !== session.id) throw new Error("Conflicting Stripe Checkout Session identity.");
    if (appointment.status !== "PENDING_PAYMENT" || payment.status === "PAID" || payment.status === "REFUNDED") return false;
    const persisted = await tx.payment.updateMany({
      where: { id: checkout.paymentId, providerCheckoutSessionId: null, checkoutRecoveryLeaseToken: checkout.leaseToken },
      data: { providerCheckoutSessionId: session.id, checkoutRecoveryLeaseToken: null, checkoutRecoveryLeasedAt: null },
    });
    return persisted.count === 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch {
    // Stripe may have created the Session, but its identity was not durably
    // recorded. A retry must not create a second chargeable Session.
    return ambiguous(checkout.paymentId, "checkout-creation-unconfirmed");
  }

  if (!persisted) return ambiguous(checkout.paymentId, "booking-changed");
  return { kind: "ready", paymentId: checkout.paymentId, checkoutUrl: session.url, expiresAt: session.expiresAt };
}

/** Internal customer-authorized entry point. The token alone selects the appointment. */
export async function startAuthorizedBookingCheckout(
  accessToken: unknown,
  dependencies: { adapter?: StripeCheckoutAdapter; clock?: CheckoutClock; afterAccessResolved?: () => Promise<void> } = {},
): Promise<CheckoutStartResult> {
  const grant = await resolveBookingAccess(accessToken);
  await dependencies.afterAccessResolved?.();
  return startBookingDepositCheckout(grant.appointmentId, dependencies.adapter ?? stripeCheckoutAdapter(), dependencies.clock ?? postgresCheckoutClock, grant);
}

function sessionMatchesPayment(
  session: Awaited<ReturnType<StripeCheckoutAdapter["createDepositCheckout"]>>,
  payment: { paymentId: string; appointmentId: string; amountCents: number; expiresAt: Date },
) {
  return session.amountCents === payment.amountCents
    && session.currency === "usd"
    && session.mode === "payment"
    && session.expiresAt.getTime() === payment.expiresAt.getTime()
    && session.metadata.paymentId === payment.paymentId
    && session.metadata.appointmentId === payment.appointmentId;
}

/**
 * Provider retrieval intentionally happens outside a database transaction.
 * Before exposing its URL, take the established Appointment -> Payment locks
 * again so cancellation, fulfillment, and access revocation win safely.
 */
async function canReturnExistingSession(
  prepared: Extract<Awaited<ReturnType<typeof prepareCheckout>>, { kind: "existing" }>,
  sessionId: string,
  clock: CheckoutClock,
  grant?: BookingAccessGrant,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, prepared.appointmentId);
    if (grant) await assertBookingAccessUnderLock(tx, grant);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payment" WHERE "id" = ${prepared.paymentId} FOR UPDATE
    `;
    if (locked.length === 0) return false;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: prepared.paymentId },
      select: { providerCheckoutSessionId: true, status: true },
    });
    const now = await clock.now(tx);
    return appointment.status === "PENDING_PAYMENT"
      && appointment.holdExpiresAt !== null
      && appointment.holdExpiresAt.getTime() > now.getTime()
      && payment.status === "PENDING"
      && payment.providerCheckoutSessionId === sessionId;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function prepareCheckout(appointmentId: string, clock: CheckoutClock, grant?: BookingAccessGrant): Promise<{ kind: "prepared" | "recovery"; checkout: PreparedCheckout } | { kind: "existing"; paymentId: string; appointmentId: string; checkoutSessionId: string; amountCents: number; expiresAt: Date } | CheckoutStartResult> {
  return prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, appointmentId);
    if (grant) await assertBookingAccessUnderLock(tx, grant);
    if (appointment.status === "CONFIRMED") throw new BookingError("BOOKING_ALREADY_CONFIRMED", "Appointment is not eligible to start checkout: it is already confirmed.");
    if (appointment.status !== "PENDING_PAYMENT" || !appointment.holdExpiresAt) throw new BookingError("BOOKING_NOT_PAYABLE", "Appointment is not eligible to start checkout.");
    const location = await tx.salonLocation.findUniqueOrThrow({ where: { id: appointment.locationId }, select: { id: true, name: true, timeZone: true, isActive: true, acceptsOnlineBooking: true } });
    await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payment"
      WHERE "appointmentId" = ${appointment.id} AND "purpose" = 'BOOKING_DEPOSIT'::"PaymentPurpose"
      FOR UPDATE
    `;
    const existing = await tx.payment.findUnique({ where: { appointmentId_purpose: { appointmentId: appointment.id, purpose: "BOOKING_DEPOSIT" } } });
    if (existing && (existing.status === "EXPIRED" || existing.status === "FAILED")) return ambiguous(existing.id, "checkout-attempt-ended");
    if (existing && (existing.status === "PAID" || existing.status === "REFUNDED")) return ambiguous(existing.id, "payment-already-received");
    if (existing?.providerCheckoutSessionId && existing.providerCheckoutExpiresAt) return { kind: "existing", paymentId: existing.id, appointmentId: appointment.id, checkoutSessionId: existing.providerCheckoutSessionId, amountCents: existing.amountCents, expiresAt: existing.providerCheckoutExpiresAt };
    // A missing local Session may be a lost Stripe response. The caller can
    // replay only this original Payment/key during the short safe window.
    if (existing && !existing.providerCheckoutExpiresAt) return ambiguous(existing.id, "checkout-creation-unconfirmed");
    if (existing) {
      const now = await clock.now(tx);
      if (existing.checkoutRecoveryLeaseToken && existing.checkoutRecoveryLeasedAt
        && existing.checkoutRecoveryLeasedAt.getTime() > now.getTime() - RECOVERY_LEASE_MS) {
        return ambiguous(existing.id, "checkout-creation-unconfirmed");
      }
      const leaseToken = randomUUID();
      const claimed = await tx.payment.updateMany({
        where: {
          id: existing.id,
          providerCheckoutSessionId: null,
          checkoutRecoveryLeaseToken: existing.checkoutRecoveryLeaseToken,
          checkoutRecoveryLeasedAt: existing.checkoutRecoveryLeasedAt,
        },
        data: { checkoutRecoveryLeaseToken: leaseToken, checkoutRecoveryLeasedAt: now },
      });
      if (claimed.count !== 1) return ambiguous(existing.id, "checkout-creation-unconfirmed");
      return { kind: "recovery", checkout: { paymentId: existing.id, appointmentId: appointment.id, amountCents: existing.amountCents, currency: "usd", expiresAt: existing.providerCheckoutExpiresAt as Date, leaseToken } };
    }
    const slotExists = await lockBookingSlotCapacity(tx, appointment.bookingSlotId);
    const slot = slotExists ? await tx.bookingSlot.findUnique({ where: { id: appointment.bookingSlotId }, select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true } }) : null;
    if (!slot || slot.locationId !== location.id) throw new BookingError("SLOT_NOT_FOUND", "Appointment slot is no longer valid.");
    if (locationClosedReason(location) || slotClosedReason(slot)) throw new BookingError("SLOT_NOT_BOOKABLE", "Appointment slot is no longer bookable.");
    const now = await clock.now(tx);
    const date = salonDateFromDatabase(appointment.appointmentDate);
    const dateReason = dateClosedReason(date, location, now);
    if (dateReason) throw new BookingError(dateReason, "Appointment date is no longer bookable.");
    const holdRemainingMs = appointment.holdExpiresAt.getTime() - now.getTime();
    if (holdRemainingMs <= 0) throw new BookingError("HOLD_EXPIRED", "The original hold has expired.");
    if (holdRemainingMs < MIN_ORIGINAL_HOLD_MS) throw new BookingError("HOLD_TIME_INSUFFICIENT", "Not enough original hold time remains to start checkout.");
    const consumed = await countConsumedCapacity(tx, { bookingSlotId: slot.id, appointmentDate: date }, now, { excludingAppointmentId: appointment.id });
    if (remainingCapacity(slot.capacity, consumed) === 0) throw new BookingError("CAPACITY_FULL", "The appointment slot is no longer available.");
    const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + CHECKOUT_WINDOW_MS);
    const holdExpiresAt = new Date(expiresAt.getTime() + HOLD_GRACE_MS);
    const leaseToken = randomUUID();
    const payment = await tx.payment.create({ data: { appointmentId: appointment.id, provider: "STRIPE", purpose: "BOOKING_DEPOSIT", amountCents: appointment.depositAmountCents, currency: "usd", providerCheckoutExpiresAt: expiresAt, checkoutRecoveryLeaseToken: leaseToken, checkoutRecoveryLeasedAt: now } });
    await tx.appointment.update({ where: { id: appointment.id }, data: { holdExpiresAt } });
    await appendAppointmentEvent(tx, appointment.id, "HOLD_EXPIRY_CHANGED", eventDetails.holdExpiryChanged({ reason: "checkout-started", before: appointment.holdExpiresAt, after: holdExpiresAt, paymentId: payment.id, checkoutExpiresAt: expiresAt, decidedAt: now }));
    return { kind: "prepared", checkout: { paymentId: payment.id, appointmentId: appointment.id, amountCents: payment.amountCents, currency: "usd", expiresAt, leaseToken } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
