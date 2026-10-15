/**
 * The admin browser credential (YASMIN-2A): an opaque session token carried
 * only in this HttpOnly cookie, never in JSON, URLs or storage.
 *
 * - `__Host-` forces Secure, Path=/ and no Domain.
 * - SameSite=Strict: admin pages are never reached through cross-site
 *   navigation that needs the session. CSRF protection still does not rely on
 *   it: every admin mutation also checks Origin (request-guards.ts).
 * - Max-Age is the session's remaining lifetime; the database stays
 *   authoritative for expiry and revocation.
 */

export const ADMIN_COOKIE_NAME = "__Host-yasmin_admin";
const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export function adminSessionCookie(token: string, expiresAt: Date, now: Date = new Date()): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${ADMIN_COOKIE_NAME}=${token}; Max-Age=${maxAgeSeconds}; Expires=${expiresAt.toUTCString()}; ${ATTRIBUTES}`;
}

export function clearedAdminSessionCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${ATTRIBUTES}`;
}

/** Exactly one cookie value, or null (absent or ambiguous: never guess). */
export function readAdminSessionCookie(headers: Headers): string | null {
  const header = headers.get("cookie");
  if (!header) return null;
  const values = header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator !== -1 && part.slice(0, separator).trim() === ADMIN_COOKIE_NAME ? [part.slice(separator + 1).trim()] : [];
  });
  return values.length === 1 ? values[0] : null;
}
