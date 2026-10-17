import { prisma } from "@/lib/prisma";
import { listBookableSlotsForDate } from "@/lib/booking/availability";
import { assertReschedulable } from "@/lib/booking/lifecycle-policy";
import { salonClockTime, salonToday } from "@/lib/booking/salon-calendar";

import { assertAdminAccess, type AdminAccess } from "./auth";

/**
 * Read-only administrator reschedule availability. The appointment identity,
 * and therefore its location, comes from the server-side record rather than
 * request input. The mutation remains authoritative and rechecks capacity.
 */
export async function getAdminRescheduleAvailability(
  access: AdminAccess,
  input: { appointmentId: string; appointmentDate: string },
) {
  assertAdminAccess(access);
  const appointment = await prisma.appointment.findUnique({
    where: { id: input.appointmentId },
    select: { locationId: true, status: true, location: { select: { timeZone: true } } },
  });
  if (!appointment) return null;
  assertReschedulable(appointment.status);

  const availability = await listBookableSlotsForDate({
    locationId: appointment.locationId,
    appointmentDate: input.appointmentDate,
  });
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const today = salonToday(appointment.location.timeZone, now);
  const clock = salonClockTime(appointment.location.timeZone, now);

  return {
    locationId: appointment.locationId,
    appointmentDate: availability.appointmentDate,
    closedReason: availability.closedReason,
    slots: availability.slots.filter((slot) =>
      slot.isBookable
      && (availability.appointmentDate !== today || `${slot.startTime}:00` > clock),
    ),
  };
}
