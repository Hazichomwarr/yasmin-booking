import { Prisma } from "@prisma/client";

import { recordPublicFormConsent } from "@/lib/customers/marketing-consent";
import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, eventDetails } from "./appointment-events";
import { assertBookingAccessUnderLock, issueBookingAccess, resolveBookingAccess, type BookingAccessGrant } from "./access";
import { isSafeToLeaveBehind } from "./booking-status";
import { dateClosedReason, locationClosedReason, publicBookingWindowClosedReason, slotClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity, remainingCapacity } from "./capacity";
import { BookingError } from "./errors";
import { BOOKING_HOLD_MINUTES } from "./holds";
import { resolveCatalogBookingPrice, v1BookingPriceSnapshot } from "./pricing";
import { PUBLIC_BOOKING_LIMITS as LIMITS, PUBLIC_EMAIL_PATTERN, PUBLIC_PHONE_PATTERN } from "./public-booking-rules";
import { parseSalonDate, salonClockTimeFromDatabase, salonDateToDatabase } from "./salon-calendar";

export type PublicBookingInput = {
  name: string;
  email: string;
  phone: string;
  locationId: string;
  bookingSlotId: string;
  appointmentDate: string;
  hairstyleId?: string | null;
  hairstyleVariantId?: string | null;
  preferredStylistName?: string | null;
  customerNotes?: string | null;
  emailMarketingConsent?: boolean;
  smsMarketingConsent?: boolean;
};

export type PublicBookingResult = {
  booking: {
    appointmentId: string;
    locationName: string;
    appointmentDate: string;
    slotTime: string;
    holdExpiresAt: Date;
    totalPriceCents: number;
    depositAmountCents: number;
    balanceDueCents: number;
  };
  /** Plaintext credential: server-side only, handed to the HttpOnly cookie and dropped. */
  accessToken: string;
  /** The credential's fixed expiry (the cookie's lifetime). */
  accessExpiresAt: Date;
};

export type PublicBookingCreateOptions = {
  /** A valid existing browser credential to consume atomically, if any. */
  replacementAccessToken?: string;
};

/** A previously valid browser credential cannot safely be replaced. */
export class PublicBookingReplacementConflictError extends Error {
  readonly code = "PUBLIC_BOOKING_REPLACEMENT_CONFLICT";
  constructor() { super("The existing booking cannot be replaced."); }
}

/** Typed, non-persisted input failure for a future HTTP 400 boundary. */
export class PublicBookingValidationError extends Error {
  readonly code = "INVALID_PUBLIC_BOOKING_INPUT";
  constructor(message: string) { super(message); }
}

const allowed = new Set(["name", "email", "phone", "locationId", "bookingSlotId", "appointmentDate", "hairstyleId", "hairstyleVariantId", "preferredStylistName", "customerNotes", "emailMarketingConsent", "smsMarketingConsent"]);

export async function createPublicBooking(value: unknown, options: PublicBookingCreateOptions = {}): Promise<PublicBookingResult> {
  const input = parsePublicBookingInput(value);
  const date = parseSalonDate(input.appointmentDate);
  const replacementGrant = options.replacementAccessToken
    ? await resolveBookingAccess(options.replacementAccessToken)
    : undefined;
  return prisma.$transaction(async (tx) => {
    if (replacementGrant) await consumeReplacementGrant(tx, replacementGrant);
    const location = await tx.salonLocation.findUnique({ where: { id: input.locationId }, select: { id: true, name: true, timeZone: true, isActive: true, acceptsOnlineBooking: true } });
    if (!location) throw new BookingError("LOCATION_NOT_FOUND", "Location does not exist.");
    if (locationClosedReason(location)) throw new BookingError("LOCATION_NOT_BOOKABLE", "Location is not bookable.");
    // V1 has exactly one online location; an ambiguous configuration closes public booking.
    const onlineLocations = await tx.salonLocation.count({ where: { isActive: true, acceptsOnlineBooking: true } });
    if (onlineLocations !== 1) throw new BookingError("LOCATION_NOT_BOOKABLE", "Online booking location is not uniquely configured.");
    const locked = await lockBookingSlotCapacity(tx, input.bookingSlotId);
    const slot = locked ? await tx.bookingSlot.findUnique({ where: { id: input.bookingSlotId }, select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true } }) : null;
    if (!slot || slot.locationId !== location.id) throw new BookingError("SLOT_NOT_FOUND", "Slot does not exist at this location.");
    if (slotClosedReason(slot)) throw new BookingError("SLOT_NOT_BOOKABLE", "Slot is not bookable.");
    // Read after the slot lock: a transaction that waited decides capacity,
    // eligibility, hold expiry and consent timestamps at lock acquisition.
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    const dateReason = dateClosedReason(date, location, now);
    if (dateReason) throw new BookingError(dateReason, "Appointment date is not bookable.");
    const windowReason = publicBookingWindowClosedReason(date, salonClockTimeFromDatabase(slot.localStartTime), location, now);
    if (windowReason) throw new BookingError(windowReason, "This date or time is outside the online booking window.");
    const consumed = await countConsumedCapacity(tx, { bookingSlotId: slot.id, appointmentDate: date }, now);
    if (remainingCapacity(slot.capacity, consumed) === 0) throw new BookingError("CAPACITY_FULL", "Slot is full.");
    const catalogPricing = input.hairstyleId
      ? await resolveCatalogBookingPrice(tx, { hairstyleId: input.hairstyleId, hairstyleVariantId: input.hairstyleVariantId })
      : null;
    const pricing = catalogPricing ?? v1BookingPriceSnapshot();
    const customer = await tx.customer.create({ data: { name: input.name, email: input.email, phone: input.phone, emailMarketingAt: input.emailMarketingConsent ? now : null, smsMarketingAt: input.smsMarketingConsent ? now : null } });
    // Marketing consent is optional, per channel, and separate from the booking itself.
    await recordPublicFormConsent(tx, customer.id, { email: input.emailMarketingConsent === true, sms: input.smsMarketingConsent === true }, now);
    const appointment = await tx.appointment.create({ data: { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: salonDateToDatabase(date), status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + BOOKING_HOLD_MINUTES * 60_000), hairstyleId: catalogPricing?.hairstyleId ?? null, hairstyleVariantId: catalogPricing?.hairstyleVariantId ?? null, preferredStylistName: text(input.preferredStylistName), customerNotes: text(input.customerNotes), locationNameSnapshot: location.name, slotTimeSnapshot: salonClockTimeFromDatabase(slot.localStartTime), hairstyleNameSnapshot: catalogPricing?.hairstyleNameSnapshot ?? null, hairstyleVariantNameSnapshot: catalogPricing?.hairstyleVariantNameSnapshot ?? null, ...pricing, currency: pricing.currency ?? "usd" } });
    const access = await issueBookingAccess(tx, appointment.id);
    await appendAppointmentEvent(tx, appointment.id, "CREATED", eventDetails.created({ status: appointment.status, holdExpiresAt: appointment.holdExpiresAt!.toISOString(), schedule: { locationId: location.id, locationName: location.name, timeZone: location.timeZone, bookingSlotId: slot.id, appointmentDate: date, slotTime: appointment.slotTimeSnapshot }, hairstyleId: appointment.hairstyleId, hairstyleNameSnapshot: appointment.hairstyleNameSnapshot, hairstyleVariantId: appointment.hairstyleVariantId, hairstyleVariantNameSnapshot: appointment.hairstyleVariantNameSnapshot, pricing }));
    return { booking: { appointmentId: appointment.id, locationName: location.name, appointmentDate: date, slotTime: appointment.slotTimeSnapshot, holdExpiresAt: appointment.holdExpiresAt!, totalPriceCents: appointment.totalPriceCents, depositAmountCents: appointment.depositAmountCents, balanceDueCents: appointment.balanceDueCents }, accessToken: access.token, accessExpiresAt: access.expiresAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Consumes the old credential and writes its audit record in this transaction. */
async function consumeReplacementGrant(tx: Prisma.TransactionClient, grant: BookingAccessGrant): Promise<void> {
  try {
    await assertBookingAccessUnderLock(tx, grant);
  } catch {
    throw new PublicBookingReplacementConflictError();
  }
  const previous = await tx.appointment.findUniqueOrThrow({
    where: { id: grant.appointmentId },
    select: {
      status: true,
      holdExpiresAt: true,
      accessTokenIssuedAt: true,
      accessTokenExpiresAt: true,
      accessTokenRevokedAt: true,
      payments: { where: { purpose: "BOOKING_DEPOSIT" }, select: { status: true, providerCheckoutSessionId: true, paidAt: true, allocatedAt: true } },
    },
  });
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const [{ unresolved }] = await tx.$queryRaw<{ unresolved: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "PaymentProcessingException"
      WHERE "expectedAppointmentId" = ${grant.appointmentId}
        AND ("resolvedAt" IS NULL OR "lastObservedAt" > "resolvedAt")
    ) AS unresolved
  `;
  const payment = previous.payments[0] ?? null;
  if (!isSafeToLeaveBehind({
    appointmentStatus: previous.status,
    holdExpiresAt: previous.holdExpiresAt,
    payment: payment && {
      status: payment.status,
      hasCheckoutSession: payment.providerCheckoutSessionId !== null,
      received: payment.paidAt !== null,
      allocated: payment.allocatedAt !== null,
    },
    unresolvedPaymentException: unresolved,
  }, now) || !previous.accessTokenIssuedAt || !previous.accessTokenExpiresAt || previous.accessTokenRevokedAt) {
    throw new PublicBookingReplacementConflictError();
  }
  await tx.appointment.update({ where: { id: grant.appointmentId }, data: { accessTokenRevokedAt: now } });
  await appendAppointmentEvent(tx, grant.appointmentId, "ACCESS_REVOKED", eventDetails.accessRevoked({
    reason: "browser-replacement",
    actorId: "public-booking-replacement",
    tokenIssuedAt: previous.accessTokenIssuedAt,
    tokenExpiresAt: previous.accessTokenExpiresAt,
    revokedAt: now,
  }));
}

/**
 * Validates and normalizes untrusted public booking input against the
 * allow-list. Throws PublicBookingValidationError; writes nothing.
 */
export function parsePublicBookingInput(value: unknown): PublicBookingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicBookingValidationError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new PublicBookingValidationError("Unknown public booking field.");
  const required = ["name", "email", "phone", "locationId", "bookingSlotId", "appointmentDate"] as const;
  for (const key of required) if (typeof record[key] !== "string" || !record[key].trim()) throw new PublicBookingValidationError(`Invalid ${key}.`);
  for (const key of ["hairstyleId", "hairstyleVariantId", "preferredStylistName", "customerNotes"]) if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") throw new PublicBookingValidationError(`Invalid ${key}.`);
  for (const key of ["emailMarketingConsent", "smsMarketingConsent"]) if (record[key] !== undefined && typeof record[key] !== "boolean") throw new PublicBookingValidationError(`Invalid ${key}.`);
  const normalized = {
    ...record,
    name: (record.name as string).trim(),
    email: (record.email as string).trim().toLowerCase(),
    phone: (record.phone as string).trim(),
    locationId: (record.locationId as string).trim(),
    bookingSlotId: (record.bookingSlotId as string).trim(),
    appointmentDate: (record.appointmentDate as string).trim(),
    emailMarketingConsent: record.emailMarketingConsent === true,
    smsMarketingConsent: record.smsMarketingConsent === true,
  } as PublicBookingInput;
  if (normalized.name.length > LIMITS.name || normalized.email.length > LIMITS.email || normalized.phone.length > LIMITS.phone || normalized.locationId.length > 191 || normalized.bookingSlotId.length > 191 || (normalized.preferredStylistName?.length ?? 0) > LIMITS.preferredStylistName || (normalized.customerNotes?.length ?? 0) > LIMITS.customerNotes) throw new PublicBookingValidationError("A field exceeds its maximum length.");
  if (!PUBLIC_EMAIL_PATTERN.test(normalized.email)) throw new PublicBookingValidationError("Invalid email.");
  if (!PUBLIC_PHONE_PATTERN.test(normalized.phone)) throw new PublicBookingValidationError("Invalid phone.");
  try { parseSalonDate(normalized.appointmentDate); } catch { throw new PublicBookingValidationError("Invalid appointmentDate."); }
  return normalized;
}

function text(value: string | null | undefined) { const trimmed = value?.trim(); return trimmed || null; }
