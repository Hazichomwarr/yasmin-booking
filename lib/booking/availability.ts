import { prisma } from "@/lib/prisma";

import {
  dateClosedReason,
  locationClosedReason,
  slotClosedReason,
  type BookingClosedReason,
} from "./booking-policy";
import {
  capacityConsumingAppointments,
  countConsumedCapacity,
  remainingCapacity,
} from "./capacity";
import { BookingError } from "./errors";
import {
  parseSalonDate,
  salonClockTimeFromDatabase,
  salonDateToDatabase,
  type SalonDate,
} from "./salon-calendar";

/**
 * Availability reads — INFORMATIONAL ONLY.
 *
 * READ says what is available now. ACQUIRE decides who actually gets it.
 *
 * These reads take no locks and can be stale the moment they return:
 * "remainingCapacity: 1" does not reserve that place. Only a successful
 * `acquireBookingHold` reserves capacity, and Stripe checkout (YASMIN-1E)
 * must be created only from a successfully acquired hold.
 *
 * Both reads apply the same booking policy and capacity rule as acquisition,
 * so UI code never reconstructs them.
 */

export type SlotAvailability = {
  bookingSlotId: string;
  /** Current salon-local start time, "HH:mm". */
  startTime: string;
  configuredCapacity: number;
  consumedCapacity: number;
  /** Never negative. */
  remainingCapacity: number;
  isBookable: boolean;
  /** Why the slot cannot be booked online right now; null when bookable. */
  unavailableReason: BookingClosedReason | null;
};

export type DateAvailability = {
  locationId: string;
  appointmentDate: SalonDate;
  /**
   * Null when the location/date accepts online bookings. Otherwise the reason
   * (LOCATION_NOT_BOOKABLE, ONLINE_BOOKING_CLOSED_FOR_DAY, or
   * INVALID_APPOINTMENT_DATE for a date before the location's local today)
   * and `slots` is empty.
   */
  closedReason: BookingClosedReason | null;
  /** Active slots ordered by start time, including full ones (remaining 0). */
  slots: SlotAvailability[];
};

/**
 * Contract: an unparseable date throws INVALID_APPOINTMENT_DATE, an unknown
 * location throws LOCATION_NOT_FOUND, and a misconfigured location timezone
 * throws LOCATION_TIME_ZONE_INVALID. Every other "not bookable" situation
 * (weekend, inactive/offline location, date before the location's local
 * today) is a normal answer: `closedReason` is set and no slots are offered.
 */
export async function listBookableSlotsForDate(
  input: { locationId: string; appointmentDate: string },
  options: { now?: Date } = {},
): Promise<DateAvailability> {
  const now = options.now ?? new Date();
  const appointmentDate = parseSalonDate(input.appointmentDate);

  const location = await prisma.salonLocation.findUnique({
    where: { id: input.locationId },
    select: { id: true, isActive: true, acceptsOnlineBooking: true, timeZone: true },
  });
  if (!location) throw locationNotFound(input.locationId);

  const closedReason = locationClosedReason(location) ?? dateClosedReason(appointmentDate, location, now);
  if (closedReason) {
    return { locationId: location.id, appointmentDate, closedReason, slots: [] };
  }

  const slots = await prisma.bookingSlot.findMany({
    where: { locationId: location.id, isActive: true },
    select: { id: true, localStartTime: true, capacity: true },
    orderBy: [{ localStartTime: "asc" }, { id: "asc" }],
  });

  const consumedBySlot = await prisma.appointment.groupBy({
    by: ["bookingSlotId"],
    where: {
      bookingSlotId: { in: slots.map((slot) => slot.id) },
      appointmentDate: salonDateToDatabase(appointmentDate),
      ...capacityConsumingAppointments(now),
    },
    _count: { _all: true },
  });
  const consumed = new Map(consumedBySlot.map((row) => [row.bookingSlotId, row._count._all]));

  return {
    locationId: location.id,
    appointmentDate,
    closedReason: null,
    slots: slots.map((slot) =>
      describeSlot(slot, consumed.get(slot.id) ?? 0, null),
    ),
  };
}

/**
 * Availability of one slot on one date. Unknown location → LOCATION_NOT_FOUND;
 * unknown slot, or a slot of another location → SLOT_NOT_FOUND.
 * Policy reasons are reported in `unavailableReason`, not thrown.
 */
export async function getSlotAvailability(
  input: { locationId: string; bookingSlotId: string; appointmentDate: string },
  options: { now?: Date } = {},
): Promise<SlotAvailability> {
  const now = options.now ?? new Date();
  const appointmentDate = parseSalonDate(input.appointmentDate);

  const location = await prisma.salonLocation.findUnique({
    where: { id: input.locationId },
    select: { id: true, isActive: true, acceptsOnlineBooking: true, timeZone: true },
  });
  if (!location) throw locationNotFound(input.locationId);

  const slot = await prisma.bookingSlot.findUnique({
    where: { id: input.bookingSlotId },
    select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true },
  });
  if (!slot || slot.locationId !== input.locationId) {
    throw slotNotFound(input.bookingSlotId, input.locationId);
  }

  const consumed = await countConsumedCapacity(
    prisma,
    { bookingSlotId: slot.id, appointmentDate },
    now,
  );
  const policyReason =
    locationClosedReason(location) ?? dateClosedReason(appointmentDate, location, now) ??
    slotClosedReason(slot);

  return describeSlot(slot, consumed, policyReason);
}

function describeSlot(
  slot: { id: string; localStartTime: Date; capacity: number },
  consumedCapacity: number,
  policyReason: BookingClosedReason | null,
): SlotAvailability {
  const remaining = remainingCapacity(slot.capacity, consumedCapacity);
  const unavailableReason = policyReason ?? (remaining === 0 ? "CAPACITY_FULL" : null);

  return {
    bookingSlotId: slot.id,
    startTime: salonClockTimeFromDatabase(slot.localStartTime),
    configuredCapacity: slot.capacity,
    consumedCapacity,
    remainingCapacity: remaining,
    isBookable: unavailableReason === null,
    unavailableReason,
  };
}

function locationNotFound(locationId: string) {
  return new BookingError("LOCATION_NOT_FOUND", `Location ${locationId} does not exist.`);
}

function slotNotFound(bookingSlotId: string, locationId: string) {
  return new BookingError(
    "SLOT_NOT_FOUND",
    `Booking slot ${bookingSlotId} does not exist at location ${locationId}.`,
  );
}
