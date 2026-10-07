import type { AppointmentStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { BookingError } from "./errors";
import { salonDateFromDatabase, type SalonDate } from "./salon-calendar";

/**
 * Shared appointment read shape and row lock for lifecycle operations.
 */

export type AppointmentView = {
  id: string;
  status: AppointmentStatus;
  customerId: string;
  locationId: string;
  bookingSlotId: string;
  appointmentDate: SalonDate;
  holdExpiresAt: Date | null;
  locationNameSnapshot: string;
  slotTimeSnapshot: string;
  hairstyleId: string | null;
  hairstyleNameSnapshot: string | null;
  preferredStylistName: string | null;
  customerNotes: string | null;
  totalPriceCents: number;
  depositAmountCents: number;
  balanceDueCents: number;
  createdAt: Date;
  updatedAt: Date;
};

export const appointmentSelect = {
  id: true,
  status: true,
  customerId: true,
  locationId: true,
  bookingSlotId: true,
  appointmentDate: true,
  holdExpiresAt: true,
  locationNameSnapshot: true,
  slotTimeSnapshot: true,
  hairstyleId: true,
  hairstyleNameSnapshot: true,
  preferredStylistName: true,
  customerNotes: true,
  totalPriceCents: true,
  depositAmountCents: true,
  balanceDueCents: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AppointmentSelect;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;

export function toAppointmentView(row: AppointmentRow): AppointmentView {
  return { ...row, appointmentDate: salonDateFromDatabase(row.appointmentDate) };
}

/** Result of a lifecycle command: `changed` is false for an idempotent no-op. */
export type AppointmentChange = { appointment: AppointmentView; changed: boolean };

export async function getAppointment(appointmentId: string): Promise<AppointmentView> {
  const row = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: appointmentSelect,
  });
  if (!row) throw appointmentNotFound(appointmentId);
  return toAppointmentView(row);
}

/**
 * Locks the appointment row until the transaction ends, then reads it.
 *
 * Every command that changes an existing appointment takes this lock FIRST,
 * so concurrent commands on the same appointment run one after another and
 * each decides based on the state left by the previous one.
 */
export async function lockAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<AppointmentRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Appointment" WHERE "id" = ${appointmentId} FOR UPDATE
  `;
  if (locked.length === 0) throw appointmentNotFound(appointmentId);

  return tx.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    select: appointmentSelect,
  });
}

function appointmentNotFound(appointmentId: string) {
  return new BookingError("APPOINTMENT_NOT_FOUND", `Appointment ${appointmentId} does not exist.`);
}
