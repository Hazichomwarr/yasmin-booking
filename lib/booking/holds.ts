import { Prisma } from "@prisma/client";

import { publiclyVisibleHairstyle } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { dateClosedReason, locationClosedReason, slotClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity, remainingCapacity } from "./capacity";
import { BookingError } from "./errors";
import { v1BookingPriceSnapshot } from "./pricing";
import {
  parseSalonDate,
  salonClockTimeFromDatabase,
  salonDateFromDatabase,
  salonDateToDatabase,
  type SalonDate,
} from "./salon-calendar";

/**
 * Temporary capacity holds.
 *
 * A hold IS an Appointment with status PENDING_PAYMENT and a future
 * holdExpiresAt. While the hold is active it consumes one place (capacity.ts).
 * When it expires it stops consuming capacity logically; nothing deletes or
 * rewrites it, and no background job is involved.
 *
 * Boundary: the caller provides an existing customerId. Creating/updating
 * Customer records (CRM, marketing consent) belongs to the booking-form
 * application layer, not the capacity engine. A failed acquisition therefore
 * never touches Customer.
 *
 * Concurrency: acquisition locks the BookingSlot row (`lockBookingSlotCapacity`)
 * before counting and inserting, inside one READ COMMITTED transaction. Two
 * requests for the last place cannot both succeed: the second blocks on the
 * row lock until the first commits, and its count then includes the first
 * hold. Tradeoff: BookingSlot is recurring, so acquisitions for the same slot
 * on different dates also queue behind each other for the few milliseconds a
 * transaction takes. Counts remain per date. At Yasmin's scale this is
 * preferable to a separate locking subsystem; a per-(slot, date) advisory
 * lock would be the upgrade path if contention ever matters.
 *
 * Stripe handoff (YASMIN-1E): the returned BookingHold carries everything
 * checkout needs (appointment id, deposit snapshot, expiry). This module does
 * not create Payments, Checkout Sessions, confirm appointments, or extend holds.
 */

/** V1 checkout window. The only place the hold duration is defined. */
export const BOOKING_HOLD_MINUTES = 15;

export type AcquireBookingHoldInput = {
  customerId: string;
  locationId: string;
  bookingSlotId: string;
  /** Salon-local calendar date, "YYYY-MM-DD". */
  appointmentDate: string;
  /** Optional; must be publicly visible (active hairstyle in an active category). */
  hairstyleId?: string | null;
  preferredStylistName?: string | null;
  customerNotes?: string | null;
};

export type BookingHold = {
  appointmentId: string;
  status: "PENDING_PAYMENT";
  customerId: string;
  locationId: string;
  bookingSlotId: string;
  appointmentDate: SalonDate;
  holdExpiresAt: Date;
  locationNameSnapshot: string;
  slotTimeSnapshot: string;
  hairstyleId: string | null;
  hairstyleNameSnapshot: string | null;
  preferredStylistName: string | null;
  customerNotes: string | null;
  totalPriceCents: number;
  depositAmountCents: number;
  balanceDueCents: number;
  createdAt: Date;
};

export function holdExpiryFor(now: Date): Date {
  return new Date(now.getTime() + BOOKING_HOLD_MINUTES * 60 * 1000);
}

/**
 * Atomically reserves one place in a slot on a salon date by creating a
 * PENDING_PAYMENT appointment that expires after BOOKING_HOLD_MINUTES.
 *
 * `options.now` is the effective time for the policy, the capacity count, and
 * the expiry (defaults to the current time, read once).
 *
 * Throws BookingError: INVALID_APPOINTMENT_DATE (malformed, or before the
 * location's local today), ONLINE_BOOKING_CLOSED_FOR_DAY, CUSTOMER_NOT_FOUND,
 * HAIRSTYLE_NOT_AVAILABLE, LOCATION_NOT_FOUND, LOCATION_NOT_BOOKABLE,
 * LOCATION_TIME_ZONE_INVALID, SLOT_NOT_FOUND,
 * SLOT_NOT_BOOKABLE, CAPACITY_FULL. On any failure nothing is written.
 */
export async function acquireBookingHold(
  input: AcquireBookingHoldInput,
  options: { now?: Date } = {},
): Promise<BookingHold> {
  const now = options.now ?? new Date();

  // 1. Date format (the date policy needs the location's timezone; see step 3).
  const appointmentDate = parseSalonDate(input.appointmentDate);

  // 2. Booking details that do not depend on capacity.
  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    select: { id: true },
  });
  if (!customer) {
    throw new BookingError("CUSTOMER_NOT_FOUND", `Customer ${input.customerId} does not exist.`);
  }
  const hairstyle = await findPublicHairstyle(input.hairstyleId);

  // 3. Capacity acquisition — serialized per BookingSlot.
  const appointment = await prisma.$transaction(
    async (tx) => {
      const location = await tx.salonLocation.findUnique({
        where: { id: input.locationId },
        select: { id: true, name: true, isActive: true, acceptsOnlineBooking: true, timeZone: true },
      });
      if (!location) {
        throw new BookingError("LOCATION_NOT_FOUND", `Location ${input.locationId} does not exist.`);
      }
      if (locationClosedReason(location)) {
        throw new BookingError("LOCATION_NOT_BOOKABLE", `${location.name} does not accept online bookings.`);
      }

      // Date policy in the location's own calendar (its timeZone defines "today").
      const dateReason = dateClosedReason(appointmentDate, location, now);
      if (dateReason === "INVALID_APPOINTMENT_DATE") {
        throw new BookingError(dateReason, `${appointmentDate} is before today at ${location.name}.`);
      }
      if (dateReason) {
        throw new BookingError(dateReason, `Online booking is closed on ${appointmentDate}; walk-ins only.`);
      }

      const slotExists = await lockBookingSlotCapacity(tx, input.bookingSlotId);
      // Read the slot AFTER locking so capacity/isActive are the latest committed values.
      const slot = slotExists
        ? await tx.bookingSlot.findUnique({
            where: { id: input.bookingSlotId },
            select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true },
          })
        : null;
      if (!slot || slot.locationId !== location.id) {
        throw new BookingError(
          "SLOT_NOT_FOUND",
          `Booking slot ${input.bookingSlotId} does not exist at ${location.name}.`,
        );
      }
      if (slotClosedReason(slot)) {
        throw new BookingError("SLOT_NOT_BOOKABLE", "This booking slot is not currently offered.");
      }

      const consumed = await countConsumedCapacity(
        tx,
        { bookingSlotId: slot.id, appointmentDate },
        now,
      );
      if (remainingCapacity(slot.capacity, consumed) === 0) {
        throw new BookingError("CAPACITY_FULL", "This booking slot is full on that date.");
      }

      return tx.appointment.create({
        data: {
          status: "PENDING_PAYMENT",
          holdExpiresAt: holdExpiryFor(now),
          customerId: customer.id,
          locationId: location.id,
          bookingSlotId: slot.id,
          appointmentDate: salonDateToDatabase(appointmentDate),
          hairstyleId: hairstyle?.id ?? null,
          preferredStylistName: optionalText(input.preferredStylistName),
          customerNotes: optionalText(input.customerNotes),
          // Booking-time facts: never recomputed from current configuration.
          locationNameSnapshot: location.name,
          slotTimeSnapshot: salonClockTimeFromDatabase(slot.localStartTime),
          hairstyleNameSnapshot: hairstyle?.name ?? null,
          ...v1BookingPriceSnapshot(),
        },
      });
    },
    // The lock-then-count argument relies on READ COMMITTED statement snapshots.
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );

  return {
    appointmentId: appointment.id,
    status: "PENDING_PAYMENT",
    customerId: appointment.customerId,
    locationId: appointment.locationId,
    bookingSlotId: appointment.bookingSlotId,
    appointmentDate: salonDateFromDatabase(appointment.appointmentDate),
    holdExpiresAt: appointment.holdExpiresAt as Date,
    locationNameSnapshot: appointment.locationNameSnapshot,
    slotTimeSnapshot: appointment.slotTimeSnapshot,
    hairstyleId: appointment.hairstyleId,
    hairstyleNameSnapshot: appointment.hairstyleNameSnapshot,
    preferredStylistName: appointment.preferredStylistName,
    customerNotes: appointment.customerNotes,
    totalPriceCents: appointment.totalPriceCents,
    depositAmountCents: appointment.depositAmountCents,
    balanceDueCents: appointment.balanceDueCents,
    createdAt: appointment.createdAt,
  };
}

/** Reuses the YASMIN-1B public-catalog rule: active hairstyle in an active category. */
async function findPublicHairstyle(hairstyleId: string | null | undefined) {
  if (hairstyleId === undefined || hairstyleId === null) return null;

  const hairstyle = await prisma.hairstyle.findFirst({
    where: { id: hairstyleId, ...publiclyVisibleHairstyle },
    select: { id: true, name: true },
  });
  if (!hairstyle) {
    throw new BookingError(
      "HAIRSTYLE_NOT_AVAILABLE",
      `Hairstyle ${hairstyleId} is not available for online booking.`,
    );
  }
  return hairstyle;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
