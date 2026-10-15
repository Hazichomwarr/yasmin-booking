import { BOOKING_ACCESS_TTL_MS } from "@/lib/booking/access";

/**
 * The browser's booking credential: the opaque 1F.1 access token, carried
 * only in this HttpOnly cookie (never JSON, URLs or storage).
 *
 * - `__Host-` forces Secure, Path=/ and no Domain, so no subdomain can set
 *   or overwrite it. The attributes are identical in every environment;
 *   local development uses https or a browser that treats localhost as secure.
 * - SameSite=Lax so it survives the top-level return navigation from Stripe;
 *   CSRF protection does not rely on it (see request-guards.ts).
 * - Lifetime: the credential's own expiry, never more than 24 hours. The
 *   database stays authoritative for expiry and revocation.
 */

export const BOOKING_COOKIE_NAME = "__Host-yasmin_booking";

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

export function bookingCookie(token: string, expiresAt: Date, now: Date = new Date()): string {
  const maxAgeSeconds = Math.max(0, Math.min(Math.floor((expiresAt.getTime() - now.getTime()) / 1000), BOOKING_ACCESS_TTL_MS / 1000));
  return `${BOOKING_COOKIE_NAME}=${token}; Max-Age=${maxAgeSeconds}; Expires=${expiresAt.toUTCString()}; ${ATTRIBUTES}`;
}

/** Deletes the cookie; same name and attributes, so the browser replaces it. */
export function clearedBookingCookie(): string {
  return `${BOOKING_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${ATTRIBUTES}`;
}

export type BookingCookieRead =
  | { kind: "absent" }
  /** Exactly one value. It is still untrusted until the access service resolves it. */
  | { kind: "present"; token: string }
  /** Several values: refused as ambiguous rather than guessing which one counts. */
  | { kind: "ambiguous" };

export function readBookingCookie(headers: Headers): BookingCookieRead {
  const header = headers.get("cookie");
  if (!header) return { kind: "absent" };
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === BOOKING_COOKIE_NAME) values.push(part.slice(separator + 1).trim());
  }
  if (values.length === 0) return { kind: "absent" };
  if (values.length > 1) return { kind: "ambiguous" };
  return { kind: "present", token: values[0] };
}
