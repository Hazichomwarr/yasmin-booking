import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { appendAppointmentEvent, eventDetails, type ScheduleFacts } from "./appointment-events";
import {
  appointmentSelect,
  lockAppointment,
  toAppointmentView,
  type AppointmentChange,
} from "./appointments";
import { dateClosedReason, locationClosedReason, slotClosedReason } from "./booking-policy";
import { countConsumedCapacity, lockBookingSlotCapacity, remainingCapacity } from "./capacity";
import { BookingError } from "./errors";
import { assertReschedulable } from "./lifecycle-policy";
import {
  parseSalonDate,
  salonClockTimeFromDatabase,
  salonDateFromDatabase,
  salonDateToDatabase,
} from "./salon-calendar";

/**
 * Rescheduling a CONFIRMED appointment (admin operation).
 *
 * The move is atomic: the appointment keeps its original place until the
 * destination place has been secured, and the update + RESCHEDULED event
 * commit together. If the destination is unavailable for any reason the
 * transaction rolls back and the appointment and its history are untouched.
 *
 * Transaction (READ COMMITTED):
 *   1. Lock the appointment row; require CONFIRMED.
 *   2. Identical destination (location, slot, date) → no-op, no event.
 *   3. Destination location: exists, active, accepts online booking; the date
 *      passes the booking date policy in the DESTINATION location's timezone.
 *      Same rules as public booking — there is no admin bypass in V1.
 *   4. Lock the destination BookingSlot (1C `lockBookingSlotCapacity`), then
 *      check it belongs to the location and is active.
 *   5. Count destination capacity with the 1C rule, excluding this
 *      appointment; CAPACITY_FULL if no place remains.
 *   6. Update date/location/slot and the location-name/slot-time snapshots.
 *      Hairstyle, stylist, notes, and money snapshots are never touched.
 *   7. Append RESCHEDULED with the before/after schedule facts.
 *
 * Locks: appointment row first, then exactly one BookingSlot row (the
 * destination). The source slot is not locked — leaving it only frees a place,
 * which cannot overbook anyone; a concurrent acquisition on the source may at
 * worst see the place as still taken until this commits. Because every
 * operation holds at most one BookingSlot lock, opposite-direction moves
 * (A: X→Y while B: Y→X) cannot deadlock on slots. If a future operation ever
 * needs two slot locks, it must take them in id order.
 *
 * Concurrent reschedules of the same appointment are serialized by the row
 * lock; the second runs against the already-moved appointment and, if still
 * valid, performs a second legitimate move with its own event.
 */

export type RescheduleAppointmentInput = {
  appointmentId: string;
  locationId: string;
  bookingSlotId: string;
  /** Destination salon-local date, "YYYY-MM-DD". */
  appointmentDate: string;
};

export async function rescheduleAppointment(
  input: RescheduleAppointmentInput,
  options: { now?: Date } = {},
): Promise<AppointmentChange> {
  const now = options.now ?? new Date();
  const destinationDate = parseSalonDate(input.appointmentDate);

  return prisma.$transaction(
    async (tx) => {
      // 1. Current state, serialized against every other command on this appointment.
      const current = await lockAppointment(tx, input.appointmentId);
      assertReschedulable(current.status);

      // 2. No-op.
      const currentDate = salonDateFromDatabase(current.appointmentDate);
      if (
        current.locationId === input.locationId &&
        current.bookingSlotId === input.bookingSlotId &&
        currentDate === destinationDate
      ) {
        return { appointment: toAppointmentView(current), changed: false };
      }

      // 3. Destination location and date policy (destination timezone).
      const location = await tx.salonLocation.findUnique({
        where: { id: input.locationId },
        select: { id: true, name: true, isActive: true, acceptsOnlineBooking: true, timeZone: true },
      });
      if (!location) {
        throw new BookingError("LOCATION_NOT_FOUND", `Location ${input.locationId} does not exist.`);
      }
      if (locationClosedReason(location)) {
        throw new BookingError("LOCATION_NOT_BOOKABLE", `${location.name} does not accept online bookings.`);
      }
      const dateReason = dateClosedReason(destinationDate, location, now);
      if (dateReason === "INVALID_APPOINTMENT_DATE") {
        throw new BookingError(dateReason, `${destinationDate} is before today at ${location.name}.`);
      }
      if (dateReason) {
        throw new BookingError(dateReason, `Online booking is closed on ${destinationDate}; walk-ins only.`);
      }

      // 4. Destination slot, locked for capacity.
      const slotExists = await lockBookingSlotCapacity(tx, input.bookingSlotId);
      const slot = slotExists
        ? await tx.bookingSlot.findUnique({
            where: { id: input.bookingSlotId },
            select: { id: true, locationId: true, localStartTime: true, capacity: true, isActive: true },
          })
        : null;
      if (!slot || slot.locationId !== location.id) {
        throw new BookingError(
          "SLOT_NOT_FOUND",
          `Booking slot ${input.bookingSlotId} does not exist at ${location.name}.`,
        );
      }
      if (slotClosedReason(slot)) {
        throw new BookingError("SLOT_NOT_BOOKABLE", "This booking slot is not currently offered.");
      }

      // 5. Destination capacity (the moving appointment never counts against itself).
      const consumed = await countConsumedCapacity(
        tx,
        { bookingSlotId: slot.id, appointmentDate: destinationDate },
        now,
        { excludingAppointmentId: current.id },
      );
      if (remainingCapacity(slot.capacity, consumed) === 0) {
        throw new BookingError("CAPACITY_FULL", "The destination slot is full on that date.");
      }

      // 6. Move.
      const sourceLocation = await tx.salonLocation.findUniqueOrThrow({
        where: { id: current.locationId },
        select: { timeZone: true },
      });
      const before: ScheduleFacts = {
        locationId: current.locationId,
        locationName: current.locationNameSnapshot,
        timeZone: sourceLocation.timeZone,
        bookingSlotId: current.bookingSlotId,
        appointmentDate: currentDate,
        slotTime: current.slotTimeSnapshot,
      };
      const after: ScheduleFacts = {
        locationId: location.id,
        locationName: location.name,
        timeZone: location.timeZone,
        bookingSlotId: slot.id,
        appointmentDate: destinationDate,
        slotTime: salonClockTimeFromDatabase(slot.localStartTime),
      };

      const updated = await tx.appointment.update({
        where: { id: current.id },
        data: {
          locationId: after.locationId,
          bookingSlotId: after.bookingSlotId,
          appointmentDate: salonDateToDatabase(destinationDate),
          locationNameSnapshot: after.locationName,
          slotTimeSnapshot: after.slotTime,
        },
        select: appointmentSelect,
      });

      // 7. History, in the same transaction.
      await appendAppointmentEvent(tx, current.id, "RESCHEDULED", eventDetails.rescheduled(before, after));

      return { appointment: toAppointmentView(updated), changed: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
