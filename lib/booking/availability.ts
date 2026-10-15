import { prisma } from "@/lib/prisma";

import {
  dateClosedReason,
  locationClosedReason,
  slotClosedReason,
  type BookingClosedReason,
  publicBookingWindowClosedReason,
  ONLINE_BOOKING_HORIZON_DAYS,
} from "./booking-policy";
import {
  capacityConsumingAppointments,
  countConsumedCapacity,
  remainingCapacity,
} from "./capacity";
import { BookingError } from "./errors";
import { v1BookingPriceSnapshot } from "./pricing";
import {
  addSalonDays,
  parseSalonDate,
  salonClockTimeFromDatabase,
  salonDateToDatabase,
  salonToday,
  type SalonDate,
} from "./salon-calendar";

export type PublicAvailability = {
  location: { id: string; name: string; timeZone: string };
  salonToday: SalonDate;
  dates: Array<{
    date: SalonDate;
    slots: Array<{ id: string; time: string; availability: "available" | "limited" | "full"; available: boolean }>;
  }>;
  pricing: { totalPriceCents: number; depositAmountCents: number; balanceDueCents: number };
};

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
  const now = options.now ?? (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
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
  const now = options.now ?? (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
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

/** Remaining places at or below this are shown as "limited"; exact counts are never public. */
export const LIMITED_AVAILABILITY_THRESHOLD = 2;

/**
 * Public, allow-listed availability for the sole configured online location:
 * salon-local today through the public horizon, weekdays only, with the
 * same-day cutoff applied. Capacity is reported as a coarse bucket, never as
 * counts. Informational only: public booking creation locks and rechecks
 * every fact before it creates a capacity-consuming Appointment.
 *
 * Zero or several active online locations → LOCATION_NOT_BOOKABLE.
 */
export async function getPublicAvailability(options: { now?: Date } = {}): Promise<PublicAvailability> {
  const now = options.now ?? (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const locations = await prisma.salonLocation.findMany({
    where: { isActive: true, acceptsOnlineBooking: true },
    select: { id: true, name: true, timeZone: true, isActive: true, acceptsOnlineBooking: true },
  });
  if (locations.length !== 1) throw new BookingError("LOCATION_NOT_BOOKABLE", "Online booking location is not uniquely configured.");
  const location = locations[0];
  const today = salonToday(location.timeZone, now);
  const lastDate = addSalonDays(today, ONLINE_BOOKING_HORIZON_DAYS);

  const slots = await prisma.bookingSlot.findMany({
    where: { locationId: location.id, isActive: true },
    select: { id: true, localStartTime: true, capacity: true },
    orderBy: [{ localStartTime: "asc" }, { id: "asc" }],
  });
  const consumedRows = await prisma.appointment.groupBy({
    by: ["bookingSlotId", "appointmentDate"],
    where: {
      bookingSlotId: { in: slots.map((slot) => slot.id) },
      appointmentDate: { gte: salonDateToDatabase(today), lte: salonDateToDatabase(lastDate) },
      ...capacityConsumingAppointments(now),
    },
    _count: { _all: true },
  });
  const consumed = new Map(consumedRows.map((row) => [`${row.bookingSlotId} ${row.appointmentDate.toISOString().slice(0, 10)}`, row._count._all]));

  const dates: PublicAvailability["dates"] = [];
  for (let offset = 0; offset <= ONLINE_BOOKING_HORIZON_DAYS; offset += 1) {
    const date = addSalonDays(today, offset);
    if (locationClosedReason(location) ?? dateClosedReason(date, location, now)) continue;
    dates.push({
      date,
      slots: slots.map((slot) => {
        const time = salonClockTimeFromDatabase(slot.localStartTime);
        const remaining = remainingCapacity(slot.capacity, consumed.get(`${slot.id} ${date}`) ?? 0);
        const windowReason = publicBookingWindowClosedReason(date, time, location, now);
        return {
          id: slot.id,
          time,
          availability: remaining === 0 ? "full" : remaining <= LIMITED_AVAILABILITY_THRESHOLD ? "limited" : "available",
          available: windowReason === null && remaining > 0,
        };
      }),
    });
  }

  return {
    location: { id: location.id, name: location.name, timeZone: location.timeZone },
    salonToday: today,
    dates,
    pricing: v1BookingPriceSnapshot(),
  };
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
