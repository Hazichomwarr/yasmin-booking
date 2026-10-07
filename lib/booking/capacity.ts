import { Prisma, type AppointmentStatus } from "@prisma/client";

import { salonDateToDatabase, type SalonDate } from "./salon-calendar";

/**
 * THE capacity rule — the only place that decides whether an Appointment
 * occupies a place in its BookingSlot on its appointmentDate.
 *
 *   CONFIRMED          consumes   (customer owns the place)
 *   COMPLETED          consumes   (the place was actually used)
 *   NO_SHOW            consumes   (the place was held for them that day)
 *   PENDING_PAYMENT    consumes ONLY while holdExpiresAt > effectiveNow
 *                      - holdExpiresAt <= effectiveNow → expired, released
 *                      - holdExpiresAt null → no valid hold interval, released
 *   CANCELLED          releases
 *
 * The Record type forces every AppointmentStatus to be classified: adding a
 * new status to the schema fails type-checking until it is placed here.
 *
 * Capacity is counted per (bookingSlotId, appointmentDate). A BookingSlot
 * belongs to exactly one location, so the slot id identifies the location.
 *
 * Expired holds are released logically by this rule; nothing deletes them.
 */

type CapacityContribution = "consumes" | "consumes-while-hold-active" | "releases";

export const CAPACITY_CONTRIBUTION: Readonly<Record<AppointmentStatus, CapacityContribution>> = {
  CONFIRMED: "consumes",
  COMPLETED: "consumes",
  NO_SHOW: "consumes",
  PENDING_PAYMENT: "consumes-while-hold-active",
  CANCELLED: "releases",
};

const statusesWith = (contribution: CapacityContribution) =>
  (Object.keys(CAPACITY_CONTRIBUTION) as AppointmentStatus[]).filter(
    (status) => CAPACITY_CONTRIBUTION[status] === contribution,
  );

/** In-memory form of the rule (for code already holding appointment rows). */
export function consumesCapacity(
  appointment: { status: AppointmentStatus; holdExpiresAt: Date | null },
  effectiveNow: Date,
): boolean {
  switch (CAPACITY_CONTRIBUTION[appointment.status]) {
    case "consumes":
      return true;
    case "consumes-while-hold-active":
      return (
        appointment.holdExpiresAt !== null &&
        appointment.holdExpiresAt.getTime() > effectiveNow.getTime()
      );
    case "releases":
      return false;
  }
}

/** Database form of the same rule, for counting in SQL. */
export function capacityConsumingAppointments(effectiveNow: Date): Prisma.AppointmentWhereInput {
  return {
    OR: [
      { status: { in: statusesWith("consumes") } },
      {
        status: { in: statusesWith("consumes-while-hold-active") },
        holdExpiresAt: { gt: effectiveNow },
      },
    ],
  };
}

/** The shared client or a transaction client. */
export type CapacityClient = Pick<Prisma.TransactionClient, "appointment">;

/** Places consumed in one slot on one salon date at `effectiveNow`. */
export function countConsumedCapacity(
  db: CapacityClient,
  slot: { bookingSlotId: string; appointmentDate: SalonDate },
  effectiveNow: Date,
): Promise<number> {
  return db.appointment.count({
    where: {
      bookingSlotId: slot.bookingSlotId,
      appointmentDate: salonDateToDatabase(slot.appointmentDate),
      ...capacityConsumingAppointments(effectiveNow),
    },
  });
}

/**
 * Serializes capacity changes for a BookingSlot until the transaction ends.
 *
 * Every operation that ADDS a capacity-consuming appointment (hold acquisition
 * now; admin booking/rescheduling in YASMIN-1D) must call this first, then
 * count, then write — all inside one READ COMMITTED transaction. Because each
 * statement in READ COMMITTED sees all rows committed before it starts, the
 * count taken after the lock includes every appointment committed by the
 * previous lock holder.
 *
 * Granularity: the lock is on the recurring BookingSlot row, so requests for
 * the same slot on DIFFERENT dates also wait for each other (briefly).
 * Counts stay independent per date. See holds.ts for the tradeoff.
 *
 * Callers locking two slots (e.g. a reschedule) must lock them in a
 * deterministic order (by id) to avoid deadlocks.
 *
 * Returns false when the slot does not exist.
 */
export async function lockBookingSlotCapacity(
  tx: Prisma.TransactionClient,
  bookingSlotId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BookingSlot" WHERE "id" = ${bookingSlotId} FOR UPDATE
  `;
  return locked.length > 0;
}

export function remainingCapacity(configuredCapacity: number, consumedCapacity: number): number {
  // Historical/manual corruption can push consumed above configured;
  // never report a negative number.
  return Math.max(0, configuredCapacity - consumedCapacity);
}
