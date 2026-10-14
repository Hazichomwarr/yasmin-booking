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

const MIN_ORIGINAL_HOLD_MS = 60_000;
const CHECKOUT_WINDOW_MS = 34 * 60_000;
const HOLD_GRACE_MS = 5 * 60_000;
const MIN_PROVIDER_CREATE_WINDOW_MS = 31 * 60_000;

export type CheckoutStartResult =
  | { kind: "ready"; paymentId: string; checkoutUrl: string; expiresAt: Date }
  | { kind: "ambiguous"; paymentId: string }
  | { kind: "retry-window-expired"; paymentId: string };

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

type PreparedCheckout = { paymentId: string; appointmentId: string; amountCents: number; currency: "usd"; expiresAt: Date };

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
    const session = await adapter.retrieveDepositCheckout(prepared.checkoutSessionId);
    if (!sessionMatchesPayment(session, prepared)) {
      throw new Error("Stored Stripe Checkout Session does not match payment facts.");
    }
    return { kind: "ready", paymentId: prepared.paymentId, checkoutUrl: session.url, expiresAt: session.expiresAt };
  }
  if (prepared.kind !== "prepared") return prepared;

  if (prepared.checkout.expiresAt.getTime() - (await clock.now()).getTime() < MIN_PROVIDER_CREATE_WINDOW_MS) {
    return { kind: "retry-window-expired", paymentId: prepared.checkout.paymentId };
  }

  let session;
  try {
    session = await adapter.createDepositCheckout(prepared.checkout);
  } catch {
    // The provider may have accepted the idempotent request. Do not create a
    // different attempt or shorten the hold without proof that no session exists.
    return { kind: "ambiguous", paymentId: prepared.checkout.paymentId };
  }

  if (!sessionMatchesPayment(session, prepared.checkout)) {
    return { kind: "ambiguous", paymentId: prepared.checkout.paymentId };
  }
  await adapter.afterCreateBeforePersistence?.(session, prepared.checkout);

  let persisted: boolean;
  try {
    persisted = await prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, prepared.checkout.appointmentId);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payment" WHERE "id" = ${prepared.checkout.paymentId} FOR UPDATE
    `;
    if (locked.length === 0) throw new Error("Prepared Payment disappeared before Checkout Session persistence.");
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: prepared.checkout.paymentId }, select: { providerCheckoutSessionId: true, status: true } });
    if (payment.providerCheckoutSessionId && payment.providerCheckoutSessionId !== session.id) throw new Error("Conflicting Stripe Checkout Session identity.");
    if (appointment.status !== "PENDING_PAYMENT" || payment.status === "PAID" || payment.status === "REFUNDED") return false;
    await tx.payment.update({ where: { id: prepared.checkout.paymentId }, data: { providerCheckoutSessionId: session.id } });
    return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch {
    // Stripe may have created the Session, but its identity was not durably
    // recorded. A retry must not create a second chargeable Session.
    return { kind: "ambiguous", paymentId: prepared.checkout.paymentId };
  }

  if (!persisted) return { kind: "ambiguous", paymentId: prepared.checkout.paymentId };
  return { kind: "ready", paymentId: prepared.checkout.paymentId, checkoutUrl: session.url, expiresAt: session.expiresAt };
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

async function prepareCheckout(appointmentId: string, clock: CheckoutClock, grant?: BookingAccessGrant): Promise<{ kind: "prepared"; checkout: PreparedCheckout } | { kind: "existing"; paymentId: string; appointmentId: string; checkoutSessionId: string; amountCents: number; expiresAt: Date } | CheckoutStartResult> {
  return prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, appointmentId);
    if (grant) await assertBookingAccessUnderLock(tx, grant);
    if (appointment.status !== "PENDING_PAYMENT" || !appointment.holdExpiresAt) throw new BookingError("APPOINTMENT_NOT_EDITABLE", "Appointment is not eligible to start checkout.");
    const location = await tx.salonLocation.findUniqueOrThrow({ where: { id: appointment.locationId }, select: { id: true, name: true, timeZone: true, isActive: true, acceptsOnlineBooking: true } });
    await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payment"
      WHERE "appointmentId" = ${appointment.id} AND "purpose" = 'BOOKING_DEPOSIT'::"PaymentPurpose"
      FOR UPDATE
    `;
    const existing = await tx.payment.findUnique({ where: { appointmentId_purpose: { appointmentId: appointment.id, purpose: "BOOKING_DEPOSIT" } } });
    if (existing?.providerCheckoutSessionId && existing.providerCheckoutExpiresAt) return { kind: "existing", paymentId: existing.id, appointmentId: appointment.id, checkoutSessionId: existing.providerCheckoutSessionId, amountCents: existing.amountCents, expiresAt: existing.providerCheckoutExpiresAt };
    if (existing) return { kind: "ambiguous", paymentId: existing.id };
    const slotExists = await lockBookingSlotCapacity(tx, appointment.bookingSlotId);
    const slot = slotExists ? await tx.bookingSlot.findUnique({ where: { id: appointment.bookingSlotId }, select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true } }) : null;
    if (!slot || slot.locationId !== location.id) throw new BookingError("SLOT_NOT_FOUND", "Appointment slot is no longer valid.");
    if (locationClosedReason(location) || slotClosedReason(slot)) throw new BookingError("SLOT_NOT_BOOKABLE", "Appointment slot is no longer bookable.");
    const now = await clock.now(tx);
    const date = salonDateFromDatabase(appointment.appointmentDate);
    const dateReason = dateClosedReason(date, location, now);
    if (dateReason) throw new BookingError(dateReason, "Appointment date is no longer bookable.");
    if (appointment.holdExpiresAt.getTime() - now.getTime() < MIN_ORIGINAL_HOLD_MS) throw new BookingError("CAPACITY_FULL", "Not enough original hold time remains to start checkout.");
    const consumed = await countConsumedCapacity(tx, { bookingSlotId: slot.id, appointmentDate: date }, now, { excludingAppointmentId: appointment.id });
    if (remainingCapacity(slot.capacity, consumed) === 0) throw new BookingError("CAPACITY_FULL", "The appointment slot is no longer available.");
    const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + CHECKOUT_WINDOW_MS);
    const holdExpiresAt = new Date(expiresAt.getTime() + HOLD_GRACE_MS);
    const payment = await tx.payment.create({ data: { appointmentId: appointment.id, provider: "STRIPE", purpose: "BOOKING_DEPOSIT", amountCents: appointment.depositAmountCents, currency: "usd", providerCheckoutExpiresAt: expiresAt } });
    await tx.appointment.update({ where: { id: appointment.id }, data: { holdExpiresAt } });
    await appendAppointmentEvent(tx, appointment.id, "HOLD_EXPIRY_CHANGED", eventDetails.holdExpiryChanged({ reason: "checkout-started", before: appointment.holdExpiresAt, after: holdExpiresAt, paymentId: payment.id, checkoutExpiresAt: expiresAt, decidedAt: now }));
    return { kind: "prepared", checkout: { paymentId: payment.id, appointmentId: appointment.id, amountCents: payment.amountCents, currency: "usd", expiresAt } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
