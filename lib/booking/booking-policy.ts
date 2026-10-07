import type { BookingErrorCode } from "./errors";
import {
  assertValidSalonTimeZone,
  salonToday,
  salonWeekday,
  type SalonDate,
  type Weekday,
} from "./salon-calendar";

/**
 * V1 public online-booking policy.
 *
 * Shared by availability reads and hold acquisition so both always agree.
 * Each check returns the reason the booking is closed, or null when open;
 * reasons are BookingError codes so acquisition can throw them directly.
 *
 * Nothing here is specific to a location or slot time: which location takes
 * online bookings, which slots exist, and their capacity all come from
 * SalonLocation / BookingSlot configuration in the database.
 */

/** Monday–Friday. Saturday and Sunday are walk-ins only. */
export const ONLINE_BOOKING_WEEKDAYS: ReadonlySet<Weekday> = new Set<Weekday>([1, 2, 3, 4, 5]);

export type BookingClosedReason = Extract<
  BookingErrorCode,
  | "INVALID_APPOINTMENT_DATE"
  | "ONLINE_BOOKING_CLOSED_FOR_DAY"
  | "LOCATION_NOT_BOOKABLE"
  | "SLOT_NOT_BOOKABLE"
  | "CAPACITY_FULL"
>;

/**
 * Date policy, evaluated in the location's own calendar.
 *
 * - Past: `date` < the location's local today (from SalonLocation.timeZone at
 *   `now`) → INVALID_APPOINTMENT_DATE. Today and later pass this check, so
 *   same-day weekday bookings are allowed; V1 has no same-day cutoff and does
 *   not compare against slot clock times.
 * - Weekday: computed from the calendar date itself; Saturday/Sunday →
 *   ONLINE_BOOKING_CLOSED_FOR_DAY.
 *
 * The comparison is between two "YYYY-MM-DD" calendar dates — never UTC
 * instants — and does not depend on the Node process timezone.
 * An invalid configured timezone throws LOCATION_TIME_ZONE_INVALID.
 */
export function dateClosedReason(
  date: SalonDate,
  location: { id: string; timeZone: string },
  now: Date,
): BookingClosedReason | null {
  const timeZone = assertValidSalonTimeZone(location.timeZone, `Location ${location.id}`);
  if (date < salonToday(timeZone, now)) return "INVALID_APPOINTMENT_DATE";
  if (!ONLINE_BOOKING_WEEKDAYS.has(salonWeekday(date))) return "ONLINE_BOOKING_CLOSED_FOR_DAY";
  return null;
}

export function locationClosedReason(location: {
  isActive: boolean;
  acceptsOnlineBooking: boolean;
}): BookingClosedReason | null {
  return location.isActive && location.acceptsOnlineBooking ? null : "LOCATION_NOT_BOOKABLE";
}

export function slotClosedReason(slot: { isActive: boolean }): BookingClosedReason | null {
  return slot.isActive ? null : "SLOT_NOT_BOOKABLE";
}
