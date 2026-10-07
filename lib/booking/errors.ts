/**
 * Expected business failures of the booking/capacity domain.
 *
 * Callers (future booking flow, Stripe checkout creation, admin tools) can
 * switch on `code`. Unexpected database/infrastructure failures are NOT
 * converted into BookingError — they propagate unchanged.
 */
export type BookingErrorCode =
  /** Malformed, impossible, or before the location's local today. */
  | "INVALID_APPOINTMENT_DATE"
  | "ONLINE_BOOKING_CLOSED_FOR_DAY"
  | "LOCATION_NOT_FOUND"
  | "LOCATION_NOT_BOOKABLE"
  /** SalonLocation.timeZone is not a canonical IANA zone (configuration error). */
  | "LOCATION_TIME_ZONE_INVALID"
  | "SLOT_NOT_FOUND"
  | "SLOT_NOT_BOOKABLE"
  | "CAPACITY_FULL"
  | "CUSTOMER_NOT_FOUND"
  | "HAIRSTYLE_NOT_AVAILABLE";

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message: string) {
    super(message);
    this.name = "BookingError";
    this.code = code;
  }
}

export function isBookingError(
  error: unknown,
  code?: BookingErrorCode,
): error is BookingError {
  return (
    error instanceof BookingError && (code === undefined || error.code === code)
  );
}
