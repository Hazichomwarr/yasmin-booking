import type { AppointmentStatus } from "@prisma/client";

export { dateLabel, money, timeLabel } from "@/components/booking/booking-format";

/** Labels for the existing AppointmentStatus values (no new lifecycle). */
export const STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  PENDING_PAYMENT: "Pending payment",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

/** An instant shown in the salon's zone, e.g. "Oct 15, 2026, 2:05 PM ET". */
export const instantLabel = (value: Date, timeZone: string) =>
  `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(value)} ${zoneShort(timeZone, value)}`;

export const zoneShort = (timeZone: string, at: Date = new Date()) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? timeZone;
