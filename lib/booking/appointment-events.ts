import type { AppointmentEventType, AppointmentStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { BookingError } from "./errors";
import type { BookingPriceSnapshot } from "./pricing";

/**
 * AppointmentEvent — the append-only audit trail of an appointment.
 *
 * Appointment holds the CURRENT state; events record what happened, in order.
 * Every event is written in the same transaction as the change it describes,
 * timestamped by the database clock (see `eventTimestamp`).
 * This module only appends and reads; there is no update or delete.
 *
 * `details` (JSON) carries the facts needed to understand the change later,
 * as plain salon-local values ("YYYY-MM-DD", "HH:mm", IANA zone) rather than
 * ambiguous instants. Each payload has a schemaVersion so future readers can
 * evolve safely.
 */

const SCHEMA_VERSION = 1;

/** Where/when an appointment is scheduled, in the location's local terms. */
export type ScheduleFacts = {
  locationId: string;
  locationName: string;
  /** The location's IANA timezone at the time the event was written. */
  timeZone: string;
  bookingSlotId: string;
  appointmentDate: string; // YYYY-MM-DD, salon-local
  slotTime: string; // HH:mm, salon-local
};

export type CreatedEventDetails = {
  schemaVersion: 1;
  status: AppointmentStatus;
  holdExpiresAt: string | null; // ISO instant
  schedule: ScheduleFacts;
  hairstyleId: string | null;
  hairstyleNameSnapshot: string | null;
  pricing: BookingPriceSnapshot;
};

export type StatusChangedEventDetails = {
  schemaVersion: 1;
  fromStatus: AppointmentStatus;
  toStatus: AppointmentStatus;
};

export type RescheduledEventDetails = {
  schemaVersion: 1;
  before: ScheduleFacts;
  after: ScheduleFacts;
};

export type FieldChangedEventDetails = {
  schemaVersion: 1;
  field: "customerNotes";
  before: string | null;
  after: string | null;
};

export type AppointmentEventDetails =
  | CreatedEventDetails
  | StatusChangedEventDetails
  | RescheduledEventDetails
  | FieldChangedEventDetails;

export const eventDetails = {
  created: (d: Omit<CreatedEventDetails, "schemaVersion">): CreatedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    ...d,
  }),
  statusChanged: (fromStatus: AppointmentStatus, toStatus: AppointmentStatus): StatusChangedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    fromStatus,
    toStatus,
  }),
  rescheduled: (before: ScheduleFacts, after: ScheduleFacts): RescheduledEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    before,
    after,
  }),
  fieldChanged: (
    field: FieldChangedEventDetails["field"],
    before: string | null,
    after: string | null,
  ): FieldChangedEventDetails => ({ schemaVersion: SCHEMA_VERSION, field, before, after }),
};

/**
 * Appends an event inside the caller's transaction.
 *
 * Call only while holding the appointment's row lock (or, for CREATED, in the
 * transaction that inserts the appointment). See `eventTimestamp` for how the
 * timestamp is chosen.
 */
export async function appendAppointmentEvent(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  type: AppointmentEventType,
  details: AppointmentEventDetails,
): Promise<void> {
  await tx.appointmentEvent.create({
    data: {
      appointmentId,
      type,
      details: details as unknown as Prisma.InputJsonObject,
      createdAt: await eventTimestamp(tx, appointmentId),
    },
  });
}

/** How long we will wait for the database clock to pass the previous event. */
const MAX_CLOCK_WAIT_MS = 20;

/**
 * The event's timestamp: the DATABASE clock (`clock_timestamp()`), read after
 * the appointment row lock is held.
 *
 * - One clock for every application instance, so app-server drift cannot
 *   reorder or future-date history. (Not `now()`/CURRENT_TIMESTAMP: that is
 *   the transaction START time, which would backdate a transaction that
 *   waited for the lock.)
 * - The row lock serializes all event writers for an appointment, so each
 *   reads the clock after the previous writer committed.
 * - `createdAt` has millisecond precision. If the clock has not yet moved past
 *   the previous event's millisecond, we wait for it to (≈1 ms) rather than
 *   inventing a later time. Timestamps are never adjusted.
 * - If the database clock is clearly BEHIND the latest event (e.g. the clock
 *   was stepped back), we refuse to write rather than record out-of-order
 *   history. This is an unexpected infrastructure failure, not a domain error.
 */
async function eventTimestamp(
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<Date> {
  const previous = await tx.appointmentEvent.findFirst({
    where: { appointmentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });

  for (let waitedMs = 0; ; waitedMs += 1) {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!previous || now.getTime() > previous.createdAt.getTime()) return now;

    if (waitedMs >= MAX_CLOCK_WAIT_MS) {
      throw new Error(
        `Database clock (${now.toISOString()}) is not after the latest event of appointment ` +
          `${appointmentId} (${previous.createdAt.toISOString()}); refusing to write out-of-order history.`,
      );
    }
    await tx.$executeRaw`SELECT pg_sleep(0.001)`;
  }
}

export type AppointmentEventRecord = {
  id: string;
  type: AppointmentEventType;
  details: AppointmentEventDetails | null;
  createdAt: Date;
};

/** The appointment's history, oldest first (createdAt, then id). */
export async function listAppointmentEvents(
  appointmentId: string,
): Promise<AppointmentEventRecord[]> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      events: {
        select: { id: true, type: true, details: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!appointment) {
    throw new BookingError("APPOINTMENT_NOT_FOUND", `Appointment ${appointmentId} does not exist.`);
  }

  return appointment.events.map((event) => ({
    ...event,
    details: event.details as AppointmentEventDetails | null,
  }));
}
