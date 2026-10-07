import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, eventDetails } from "./appointment-events";
import {
  appointmentSelect,
  lockAppointment,
  toAppointmentView,
  type AppointmentChange,
} from "./appointments";
import {
  assertDetailsEditable,
  decideTransition,
  type LifecycleCommand,
} from "./lifecycle-policy";

/**
 * Appointment lifecycle commands (admin operations).
 *
 * Each command, in one READ COMMITTED transaction:
 *   1. locks the appointment row,
 *   2. asks lifecycle-policy what the command means for the current status,
 *   3. updates the appointment and appends exactly one event — or does
 *      nothing when the appointment is already in the target state.
 *
 * Nothing is deleted. Snapshots, money, customer, and payments are untouched.
 * No refunds, charges, or notifications happen here.
 */

/**
 * PENDING_PAYMENT → CANCELLED (releases a hold) or CONFIRMED → CANCELLED.
 * CANCELLED never consumes capacity, so the place is released immediately.
 * Payments are kept as-is; refund policy belongs to the payment domain.
 */
export function cancelAppointment(appointmentId: string): Promise<AppointmentChange> {
  return runLifecycleCommand(appointmentId, "cancel");
}

/** CONFIRMED → COMPLETED. Does not collect the remaining balance. */
export function completeAppointment(appointmentId: string): Promise<AppointmentChange> {
  return runLifecycleCommand(appointmentId, "complete");
}

/** CONFIRMED → NO_SHOW. Does not charge or refund anything. */
export function markAppointmentNoShow(appointmentId: string): Promise<AppointmentChange> {
  return runLifecycleCommand(appointmentId, "markNoShow");
}

/**
 * Replaces the customer's notes/request on a PENDING_PAYMENT or CONFIRMED
 * appointment and records NOTE_UPDATED with the old and new values.
 * Blank text clears the notes. An unchanged value is a no-op.
 */
export async function updateAppointmentCustomerNotes(
  appointmentId: string,
  customerNotes: string | null,
): Promise<AppointmentChange> {
  const next = customerNotes?.trim() || null;

  return prisma.$transaction(
    async (tx) => {
      const current = await lockAppointment(tx, appointmentId);
      assertDetailsEditable(current.status);
      if (current.customerNotes === next) {
        return { appointment: toAppointmentView(current), changed: false };
      }

      const updated = await tx.appointment.update({
        where: { id: appointmentId },
        data: { customerNotes: next },
        select: appointmentSelect,
      });
      await appendAppointmentEvent(
        tx,
        appointmentId,
        "NOTE_UPDATED",
        eventDetails.fieldChanged("customerNotes", current.customerNotes, next),
      );
      return { appointment: toAppointmentView(updated), changed: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

async function runLifecycleCommand(
  appointmentId: string,
  command: LifecycleCommand,
): Promise<AppointmentChange> {
  return prisma.$transaction(
    async (tx) => {
      const current = await lockAppointment(tx, appointmentId);
      const decision = decideTransition(command, current.status);
      if (decision.kind === "already-applied") {
        return { appointment: toAppointmentView(current), changed: false };
      }

      const updated = await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: decision.to },
        select: appointmentSelect,
      });
      await appendAppointmentEvent(
        tx,
        appointmentId,
        decision.event,
        eventDetails.statusChanged(current.status, decision.to),
      );
      return { appointment: toAppointmentView(updated), changed: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
