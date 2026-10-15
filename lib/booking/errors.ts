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
  | "HAIRSTYLE_NOT_AVAILABLE"
  | "APPOINTMENT_NOT_FOUND"
  /** The lifecycle command is not allowed from the appointment's current status. */
  | "INVALID_APPOINTMENT_TRANSITION"
  /** Only CONFIRMED appointments can be rescheduled in V1. */
  | "APPOINTMENT_NOT_RESCHEDULABLE"
  /** Booking details can only be edited while PENDING_PAYMENT or CONFIRMED. */
  | "APPOINTMENT_NOT_EDITABLE"
  /** Checkout: the booking is cancelled, closed, or otherwise not awaiting payment. */
  | "BOOKING_NOT_PAYABLE"
  /** Checkout: the booking is already confirmed by a verified payment. */
  | "BOOKING_ALREADY_CONFIRMED"
  /** Checkout: the original hold has expired. */
  | "HOLD_EXPIRED"
  /** Checkout: the hold is still active but too little of it remains to start Checkout. */
  | "HOLD_TIME_INSUFFICIENT";

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

/**
 * Why a booking-access token was refused. Internal only — for logs and
 * support. A public boundary must answer every reason identically, so a
 * caller cannot learn whether a token or appointment ever existed.
 */
export type BookingAccessDenialReason =
  /** Not a well-formed token; the database was not consulted. */
  | "MALFORMED"
  /** No appointment holds this token (never issued, or a different one now). */
  | "UNKNOWN"
  | "EXPIRED"
  | "REVOKED";

/**
 * An authorization failure: the caller did not prove access to a booking.
 * Deliberately separate from BookingError (booking-state failures), which a
 * caller may only see after access was proven. Never carries the token, its
 * hash, or the appointment id.
 */
export class BookingAccessError extends Error {
  readonly code = "BOOKING_ACCESS_DENIED";
  readonly reason: BookingAccessDenialReason;

  constructor(reason: BookingAccessDenialReason) {
    super("Booking access denied.");
    this.name = "BookingAccessError";
    this.reason = reason;
  }
}

export function isBookingAccessError(
  error: unknown,
  reason?: BookingAccessDenialReason,
): error is BookingAccessError {
  return (
    error instanceof BookingAccessError && (reason === undefined || error.reason === reason)
  );
}
