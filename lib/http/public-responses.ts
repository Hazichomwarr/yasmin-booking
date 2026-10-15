import type { BookingErrorCode } from "@/lib/booking/errors";

/**
 * Every public API response is built here, so security headers and the
 * error envelope can never be forgotten:
 *
 *   { "error": { "code": "<STABLE_CODE>", "message": "<fixed text>" } }
 *
 * Messages are fixed strings from this table. Domain, Prisma, Stripe or
 * runtime messages are never copied into a response.
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export const PUBLIC_ERRORS = {
  NOT_FOUND: { status: 404, message: "Not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  REQUEST_ORIGIN_REJECTED: { status: 403, message: "This request was not accepted." },
  UNSUPPORTED_CONTENT_TYPE: { status: 415, message: "Send the request as application/json." },
  REQUEST_TOO_LARGE: { status: 413, message: "The request is too large." },
  INVALID_JSON: { status: 400, message: "The request body must be a JSON object." },
  INVALID_REQUEST: { status: 400, message: "The request is not valid." },
  INVALID_BOOKING_INPUT: { status: 400, message: "Some booking details are missing or invalid." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please wait and try again." },
  BOOKING_ACCESS_DENIED: { status: 401, message: "No active booking was found in this browser." },
  ACTIVE_BOOKING_EXISTS: { status: 409, message: "This browser already has a booking in progress." },
  SLOT_FULL: { status: 409, message: "This time is no longer available." },
  BOOKING_OPTION_UNAVAILABLE: { status: 409, message: "This booking option is not available." },
  BOOKING_ALREADY_CONFIRMED: { status: 409, message: "This booking is already confirmed." },
  BOOKING_NOT_PAYABLE: { status: 409, message: "This booking can no longer be paid." },
  HOLD_EXPIRED: { status: 409, message: "Your reserved time has expired. Please start a new booking." },
  HOLD_TIME_INSUFFICIENT: { status: 409, message: "Too little reserved time remains to pay. You can start a new booking once it expires." },
  CHECKOUT_TEMPORARILY_UNAVAILABLE: { status: 503, message: "Payment is temporarily unavailable. Please try again shortly." },
  CHECKOUT_OUTCOME_UNCERTAIN: { status: 409, message: "We could not confirm whether payment was started. Please do not start a new booking; check your booking status or contact the salon." },
  CHECKOUT_NEEDS_ASSISTANCE: { status: 409, message: "We could not start payment for this booking. Please contact the salon." },
  PAYMENT_AWAITING_CONFIRMATION: { status: 409, message: "Your payment is being confirmed. Please check your booking status." },
  PAYMENT_RECEIVED: { status: 409, message: "A payment was received for this booking. The salon will confirm it or contact you." },
  CHECKOUT_ATTEMPT_ENDED: { status: 409, message: "This payment attempt ended without a charge. Please start a new booking." },
  BOOKING_STATE_CHANGED: { status: 409, message: "This booking changed while payment was starting. Please check your booking status." },
  CHECKOUT_PROVIDER_ERROR: { status: 502, message: "Payment is temporarily unavailable. Please try again shortly." },
  SERVICE_UNAVAILABLE: { status: 503, message: "The booking service is temporarily unavailable." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong." },
} as const satisfies Record<string, { status: number; message: string }>;

export type PublicErrorCode = keyof typeof PUBLIC_ERRORS;

/**
 * Exhaustive: adding a BookingErrorCode fails compilation until it is mapped.
 * Codes that a public flow cannot legitimately produce map to INTERNAL_ERROR
 * or SERVICE_UNAVAILABLE rather than revealing internals.
 */
export const BOOKING_ERROR_TO_PUBLIC: Readonly<Record<BookingErrorCode, PublicErrorCode>> = {
  INVALID_APPOINTMENT_DATE: "BOOKING_OPTION_UNAVAILABLE",
  ONLINE_BOOKING_CLOSED_FOR_DAY: "BOOKING_OPTION_UNAVAILABLE",
  LOCATION_NOT_FOUND: "BOOKING_OPTION_UNAVAILABLE",
  LOCATION_NOT_BOOKABLE: "BOOKING_OPTION_UNAVAILABLE",
  LOCATION_TIME_ZONE_INVALID: "SERVICE_UNAVAILABLE",
  SLOT_NOT_FOUND: "BOOKING_OPTION_UNAVAILABLE",
  SLOT_NOT_BOOKABLE: "BOOKING_OPTION_UNAVAILABLE",
  CAPACITY_FULL: "SLOT_FULL",
  CUSTOMER_NOT_FOUND: "INTERNAL_ERROR",
  HAIRSTYLE_NOT_AVAILABLE: "BOOKING_OPTION_UNAVAILABLE",
  APPOINTMENT_NOT_FOUND: "INTERNAL_ERROR",
  INVALID_APPOINTMENT_TRANSITION: "INTERNAL_ERROR",
  APPOINTMENT_NOT_RESCHEDULABLE: "INTERNAL_ERROR",
  APPOINTMENT_NOT_EDITABLE: "BOOKING_NOT_PAYABLE",
  BOOKING_NOT_PAYABLE: "BOOKING_NOT_PAYABLE",
  BOOKING_ALREADY_CONFIRMED: "BOOKING_ALREADY_CONFIRMED",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  HOLD_TIME_INSUFFICIENT: "HOLD_TIME_INSUFFICIENT",
};

export type ResponseOptions = { setCookie?: string; headers?: Record<string, string> };

export function publicJson(status: number, body: unknown, options: ResponseOptions = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...options.headers });
  if (options.setCookie) headers.append("Set-Cookie", options.setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function publicError(code: PublicErrorCode, options: ResponseOptions = {}): Response {
  const { status, message } = PUBLIC_ERRORS[code];
  return publicJson(status, { error: { code, message } }, options);
}
