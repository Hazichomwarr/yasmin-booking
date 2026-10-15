/**
 * Public booking contact-field rules, shared by the server parser
 * (`parsePublicBookingInput`) and the browser form so both always agree.
 * Browser-safe: no server imports.
 */

export const PUBLIC_BOOKING_LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  preferredStylistName: 120,
  customerNotes: 2_000,
} as const;

export const PUBLIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Optional "+", optional "(" (as in "(555) 010-0100"), a digit, then digits,
 * spaces, dots, parentheses or hyphens; at most PUBLIC_BOOKING_LIMITS.phone
 * characters overall. The number is stored exactly as typed (trimmed only):
 * no country code is added and no digit is changed.
 */
export const PUBLIC_PHONE_PATTERN = /^\+?\(?[0-9][0-9 .()\-]{5,39}$/;

export type PublicContactField = "name" | "email" | "phone" | "preferredStylistName";

/** Customer-facing problems per field; empty when the values would pass the server parser. */
export function publicContactProblems(values: Record<PublicContactField, string>): Partial<Record<PublicContactField, string>> {
  const problems: Partial<Record<PublicContactField, string>> = {};
  const name = values.name.trim();
  const email = values.email.trim();
  const phone = values.phone.trim();
  if (!name) problems.name = "Enter your full name.";
  else if (name.length > PUBLIC_BOOKING_LIMITS.name) problems.name = `Use at most ${PUBLIC_BOOKING_LIMITS.name} characters.`;
  if (!email) problems.email = "Enter your email address.";
  else if (email.length > PUBLIC_BOOKING_LIMITS.email || !PUBLIC_EMAIL_PATTERN.test(email)) problems.email = "Enter a valid email address, like name@example.com.";
  if (!phone) problems.phone = "Enter your phone number.";
  else if (phone.length > PUBLIC_BOOKING_LIMITS.phone || !PUBLIC_PHONE_PATTERN.test(phone)) problems.phone = "Enter a valid phone number, like (555) 010-0100.";
  if (values.preferredStylistName.trim().length > PUBLIC_BOOKING_LIMITS.preferredStylistName) {
    problems.preferredStylistName = `Use at most ${PUBLIC_BOOKING_LIMITS.preferredStylistName} characters.`;
  }
  return problems;
}
