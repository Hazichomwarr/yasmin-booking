import type { BookingErrorCode } from "./errors";
import {
  assertValidSalonTimeZone,
  addSalonDays,
  salonClockTime,
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
export const ONLINE_BOOKING_HORIZON_DAYS = 30;
export const SAME_DAY_BOOKING_CUTOFF_MINUTES = 60;

export type BookingClosedReason = Extract<
  BookingErrorCode,
  | "INVALID_APPOINTMENT_DATE"
  | "ONLINE_BOOKING_CLOSED_FOR_DAY"
  | "LOCATION_NOT_BOOKABLE"
  | "SLOT_NOT_BOOKABLE"
  | "CAPACITY_FULL"
>;

/** Why a slot is not bookable on a date apart from capacity (location, date or slot policy). */
export type PlacePolicyClosedReason = Exclude<BookingClosedReason, "CAPACITY_FULL">;

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
): PlacePolicyClosedReason | null {
  const timeZone = assertValidSalonTimeZone(location.timeZone, `Location ${location.id}`);
  if (date < salonToday(timeZone, now)) return "INVALID_APPOINTMENT_DATE";
  if (!ONLINE_BOOKING_WEEKDAYS.has(salonWeekday(date))) return "ONLINE_BOOKING_CLOSED_FOR_DAY";
  return null;
}

/**
 * The PUBLIC booking window (YASMIN-1G), applied only where a customer creates
 * or is offered a new reservation — public creation and public availability.
 * Internal holds, rescheduling, Checkout and payment fulfillment deliberately
 * do not apply it: a paid booking must never be refused because of it.
 *
 * - Horizon: salon-local today through today + ONLINE_BOOKING_HORIZON_DAYS
 *   calendar days, inclusive → beyond it INVALID_APPOINTMENT_DATE.
 * - Same-day cutoff: a slot on the salon's local today needs at least
 *   SAME_DAY_BOOKING_CUTOFF_MINUTES (exactly 60:00 is accepted, 59:59 is not)
 *   between the salon-local wall clock now and the slot's local start time
 *   → ONLINE_BOOKING_CLOSED_FOR_DAY. Wall-clock time is intentional: a DST
 *   transition happens at 02:00 local, before every configured slot.
 */
export function publicBookingWindowClosedReason(
  date: SalonDate,
  slotTime: string,
  location: { id: string; timeZone: string },
  now: Date,
): PlacePolicyClosedReason | null {
  const timeZone = assertValidSalonTimeZone(location.timeZone, `Location ${location.id}`);
  const today = salonToday(timeZone, now);
  if (date > addSalonDays(today, ONLINE_BOOKING_HORIZON_DAYS)) return "INVALID_APPOINTMENT_DATE";
  if (date !== today) return null;
  const slot = /^(\d{2}):(\d{2})$/.exec(slotTime);
  if (!slot) return "SLOT_NOT_BOOKABLE";
  const [nowHour, nowMinute, nowSecond] = salonClockTime(timeZone, now).split(":").map(Number);
  const secondsUntilSlot = Number(slot[1]) * 3600 + Number(slot[2]) * 60 - (nowHour * 3600 + nowMinute * 60 + nowSecond);
  return secondsUntilSlot >= SAME_DAY_BOOKING_CUTOFF_MINUTES * 60 ? null : "ONLINE_BOOKING_CLOSED_FOR_DAY";
}

export function locationClosedReason(location: {
  isActive: boolean;
  acceptsOnlineBooking: boolean;
}): PlacePolicyClosedReason | null {
  return location.isActive && location.acceptsOnlineBooking ? null : "LOCATION_NOT_BOOKABLE";
}

export function slotClosedReason(slot: { isActive: boolean }): PlacePolicyClosedReason | null {
  return slot.isActive ? null : "SLOT_NOT_BOOKABLE";
}

/**
 * The full non-capacity policy for one (location, slot, date) at `now`, in
 * the order hold acquisition applies it: location, then date, then slot.
 */
export function placePolicyClosedReason(
  location: { id: string; timeZone: string; isActive: boolean; acceptsOnlineBooking: boolean },
  slot: { isActive: boolean },
  date: SalonDate,
  now: Date,
): PlacePolicyClosedReason | null {
  return locationClosedReason(location) ?? dateClosedReason(date, location, now) ?? slotClosedReason(slot);
}
