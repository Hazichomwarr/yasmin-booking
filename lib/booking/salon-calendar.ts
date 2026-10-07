import { BookingError } from "./errors";

/**
 * Salon-local calendar dates and clock times.
 *
 * Appointment.appointmentDate (PostgreSQL DATE) is a salon-local calendar
 * date, and BookingSlot.localStartTime (PostgreSQL TIME(0)) is a salon-local
 * recurring clock time. Neither is a UTC instant.
 *
 * Prisma represents both as JS Dates pinned to UTC:
 * - DATE "2027-03-08"  ⇄ 2027-03-08T00:00:00.000Z
 * - TIME "11:00:00"    ⇄ 1970-01-01T11:00:00.000Z
 *
 * Every conversion here uses UTC accessors/ISO strings only, so the Node
 * process timezone (TZ) can never shift a date, a weekday, or a clock time.
 * Business logic works with the plain "YYYY-MM-DD" and "HH:mm" strings.
 */

declare const salonDateBrand: unique symbol;

/** A validated salon-local calendar date, "YYYY-MM-DD". */
export type SalonDate = string & { readonly [salonDateBrand]: true };

/** 0 = Sunday … 6 = Saturday, computed from the calendar date itself. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const SALON_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseSalonDate(value: unknown): SalonDate {
  const match = typeof value === "string" ? SALON_DATE_PATTERN.exec(value.trim()) : null;
  if (!match) {
    throw new BookingError("INVALID_APPOINTMENT_DATE", "Appointment date must be YYYY-MM-DD.");
  }

  const [, year, month, day] = match.map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const isRealCalendarDate =
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day;
  if (!isRealCalendarDate) {
    throw new BookingError("INVALID_APPOINTMENT_DATE", `${match[0]} is not a calendar date.`);
  }

  return match[0] as SalonDate;
}

/** Value to write to a PostgreSQL DATE column through Prisma. */
export function salonDateToDatabase(date: SalonDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Reads a PostgreSQL DATE column value returned by Prisma. */
export function salonDateFromDatabase(value: Date): SalonDate {
  return value.toISOString().slice(0, 10) as SalonDate;
}

export function salonWeekday(date: SalonDate): Weekday {
  return salonDateToDatabase(date).getUTCDay() as Weekday;
}

/** Reads a PostgreSQL TIME(0) column value returned by Prisma as "HH:mm". */
export function salonClockTimeFromDatabase(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/**
 * SalonLocation.timeZone must be a canonical IANA zone (e.g. "America/New_York")
 * as known to the platform's Intl data. Abbreviations ("EST"), fixed offsets
 * ("+05:00", "Etc/GMT+5"), "UTC" and legacy aliases ("US/Eastern") are
 * rejected: they either ignore daylight saving or hide the real location.
 *
 * Misconfiguration fails explicitly — there is no fallback to UTC or to the
 * server/browser timezone.
 */
export function assertValidSalonTimeZone(timeZone: unknown, locationLabel: string): string {
  if (typeof timeZone !== "string" || !Intl.supportedValuesOf("timeZone").includes(timeZone)) {
    throw new BookingError(
      "LOCATION_TIME_ZONE_INVALID",
      `${locationLabel} has an invalid timeZone configuration; expected a canonical IANA zone such as "America/New_York".`,
    );
  }
  return timeZone;
}

/**
 * The salon's local calendar date at the instant `now`, in `timeZone`.
 * Uses Intl with an explicit timeZone, so the Node process TZ is irrelevant
 * and daylight-saving transitions follow the IANA rules.
 */
export function salonToday(timeZone: string, now: Date): SalonDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}` as SalonDate;
}
