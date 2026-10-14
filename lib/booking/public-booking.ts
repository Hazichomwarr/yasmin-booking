import { Prisma } from "@prisma/client";

import { publiclyVisibleHairstyle } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, eventDetails } from "./appointment-events";
import { issueBookingAccess } from "./access";
import { dateClosedReason, locationClosedReason, slotClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity, remainingCapacity } from "./capacity";
import { BookingError } from "./errors";
import { BOOKING_HOLD_MINUTES } from "./holds";
import { v1BookingPriceSnapshot } from "./pricing";
import { parseSalonDate, salonClockTimeFromDatabase, salonDateToDatabase } from "./salon-calendar";

export type PublicBookingInput = {
  name: string;
  email: string;
  phone: string;
  locationId: string;
  bookingSlotId: string;
  appointmentDate: string;
  hairstyleId?: string | null;
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
  accessToken: string;
};

/** Typed, non-persisted input failure for a future HTTP 400 boundary. */
export class PublicBookingValidationError extends Error {
  readonly code = "INVALID_PUBLIC_BOOKING_INPUT";
  constructor(message: string) { super(message); }
}

const allowed = new Set(["name", "email", "phone", "locationId", "bookingSlotId", "appointmentDate", "hairstyleId", "preferredStylistName", "customerNotes", "emailMarketingConsent", "smsMarketingConsent"]);

export async function createPublicBooking(value: unknown): Promise<PublicBookingResult> {
  const input = validate(value);
  const date = parseSalonDate(input.appointmentDate);
  return prisma.$transaction(async (tx) => {
    const location = await tx.salonLocation.findUnique({ where: { id: input.locationId }, select: { id: true, name: true, timeZone: true, isActive: true, acceptsOnlineBooking: true } });
    if (!location) throw new BookingError("LOCATION_NOT_FOUND", "Location does not exist.");
    if (locationClosedReason(location)) throw new BookingError("LOCATION_NOT_BOOKABLE", "Location is not bookable.");
    const locked = await lockBookingSlotCapacity(tx, input.bookingSlotId);
    const slot = locked ? await tx.bookingSlot.findUnique({ where: { id: input.bookingSlotId }, select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true } }) : null;
    if (!slot || slot.locationId !== location.id) throw new BookingError("SLOT_NOT_FOUND", "Slot does not exist at this location.");
    if (slotClosedReason(slot)) throw new BookingError("SLOT_NOT_BOOKABLE", "Slot is not bookable.");
    // Read after the slot lock: a transaction that waited decides capacity,
    // eligibility, hold expiry and consent timestamps at lock acquisition.
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    const dateReason = dateClosedReason(date, location, now);
    if (dateReason) throw new BookingError(dateReason, "Appointment date is not bookable.");
    const consumed = await countConsumedCapacity(tx, { bookingSlotId: slot.id, appointmentDate: date }, now);
    if (remainingCapacity(slot.capacity, consumed) === 0) throw new BookingError("CAPACITY_FULL", "Slot is full.");
    const hairstyle = input.hairstyleId ? await tx.hairstyle.findFirst({ where: { id: input.hairstyleId, ...publiclyVisibleHairstyle }, select: { id: true, name: true } }) : null;
    if (input.hairstyleId && !hairstyle) throw new BookingError("HAIRSTYLE_NOT_AVAILABLE", "Hairstyle is not available.");
    const customer = await tx.customer.create({ data: { name: input.name, email: input.email, phone: input.phone, emailMarketingAt: input.emailMarketingConsent ? now : null, smsMarketingAt: input.smsMarketingConsent ? now : null } });
    const appointment = await tx.appointment.create({ data: { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: salonDateToDatabase(date), status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + BOOKING_HOLD_MINUTES * 60_000), hairstyleId: hairstyle?.id ?? null, preferredStylistName: text(input.preferredStylistName), customerNotes: text(input.customerNotes), locationNameSnapshot: location.name, slotTimeSnapshot: salonClockTimeFromDatabase(slot.localStartTime), hairstyleNameSnapshot: hairstyle?.name ?? null, ...v1BookingPriceSnapshot() } });
    const access = await issueBookingAccess(tx, appointment.id);
    await appendAppointmentEvent(tx, appointment.id, "CREATED", eventDetails.created({ status: appointment.status, holdExpiresAt: appointment.holdExpiresAt!.toISOString(), schedule: { locationId: location.id, locationName: location.name, timeZone: location.timeZone, bookingSlotId: slot.id, appointmentDate: date, slotTime: appointment.slotTimeSnapshot }, hairstyleId: appointment.hairstyleId, hairstyleNameSnapshot: appointment.hairstyleNameSnapshot, pricing: v1BookingPriceSnapshot() }));
    return { booking: { appointmentId: appointment.id, locationName: location.name, appointmentDate: date, slotTime: appointment.slotTimeSnapshot, holdExpiresAt: appointment.holdExpiresAt!, totalPriceCents: appointment.totalPriceCents, depositAmountCents: appointment.depositAmountCents, balanceDueCents: appointment.balanceDueCents }, accessToken: access.token };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function validate(value: unknown): PublicBookingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicBookingValidationError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new PublicBookingValidationError("Unknown public booking field.");
  const required = ["name", "email", "phone", "locationId", "bookingSlotId", "appointmentDate"] as const;
  for (const key of required) if (typeof record[key] !== "string" || !record[key].trim()) throw new PublicBookingValidationError(`Invalid ${key}.`);
  for (const key of ["hairstyleId", "preferredStylistName", "customerNotes"]) if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") throw new PublicBookingValidationError(`Invalid ${key}.`);
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
  if (normalized.name.length > 120 || normalized.email.length > 254 || normalized.phone.length > 40 || normalized.locationId.length > 191 || normalized.bookingSlotId.length > 191 || (normalized.preferredStylistName?.length ?? 0) > 120 || (normalized.customerNotes?.length ?? 0) > 2_000) throw new PublicBookingValidationError("A field exceeds its maximum length.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) throw new PublicBookingValidationError("Invalid email.");
  if (!/^\+?[0-9][0-9 .()\-]{5,39}$/.test(normalized.phone)) throw new PublicBookingValidationError("Invalid phone.");
  try { parseSalonDate(normalized.appointmentDate); } catch { throw new PublicBookingValidationError("Invalid appointmentDate."); }
  return normalized;
}

function text(value: string | null | undefined) { const trimmed = value?.trim(); return trimmed || null; }
