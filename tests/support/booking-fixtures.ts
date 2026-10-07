import type { AppointmentStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Booking test data. Locations are created per test with their own ids —
 * tests never touch the William Street seed (which does not exist in the
 * test database anyway).
 */

/** Fixed effective time: Monday 2027-03-01 15:00 UTC (10:00 in New York). */
export const NOW = new Date("2027-03-01T15:00:00.000Z");

/** The following week, as salon calendar dates. */
export const WEEK = {
  monday: "2027-03-08",
  tuesday: "2027-03-09",
  wednesday: "2027-03-10",
  thursday: "2027-03-11",
  friday: "2027-03-12",
  saturday: "2027-03-13",
  sunday: "2027-03-14",
} as const;

export const seconds = (n: number) => n * 1000;

type SlotSpec = { time: string; capacity?: number; isActive?: boolean };

export async function createLocation(
  options: {
    name?: string;
    timeZone?: string;
    isActive?: boolean;
    acceptsOnlineBooking?: boolean;
    slots?: SlotSpec[];
  } = {},
) {
  const location = await prisma.salonLocation.create({
    data: {
      name: options.name ?? "Test Street",
      timeZone: options.timeZone ?? "America/New_York",
      isActive: options.isActive ?? true,
      acceptsOnlineBooking: options.acceptsOnlineBooking ?? true,
    },
  });

  const slots = [];
  for (const spec of options.slots ?? [{ time: "11:00" }]) {
    slots.push(
      await prisma.bookingSlot.create({
        data: {
          locationId: location.id,
          localStartTime: new Date(`1970-01-01T${spec.time}:00.000Z`),
          capacity: spec.capacity ?? 10,
          isActive: spec.isActive ?? true,
        },
      }),
    );
  }

  return { location, slots, slot: slots[0] };
}

let customerSequence = 0;

export async function createCustomer() {
  customerSequence += 1;
  return prisma.customer.create({
    data: {
      name: `Customer ${customerSequence}`,
      email: `customer${customerSequence}@example.test`,
      phone: `555-01${String(customerSequence).padStart(2, "0")}`,
    },
  });
}

/** Inserts an appointment directly (bypassing the engine) to set up capacity states. */
export async function insertAppointment(options: {
  slot: { id: string; locationId: string };
  customerId: string;
  appointmentDate: string;
  status: AppointmentStatus;
  holdExpiresAt?: Date | null;
}) {
  return prisma.appointment.create({
    data: {
      customerId: options.customerId,
      locationId: options.slot.locationId,
      bookingSlotId: options.slot.id,
      appointmentDate: new Date(`${options.appointmentDate}T00:00:00.000Z`),
      status: options.status,
      holdExpiresAt: options.holdExpiresAt ?? null,
      locationNameSnapshot: "Seeded",
      slotTimeSnapshot: "11:00",
      totalPriceCents: 20000,
      depositAmountCents: 4000,
      balanceDueCents: 16000,
    },
  });
}

/** Inserts `count` CONFIRMED appointments. */
export async function fillSlot(
  slot: { id: string; locationId: string },
  appointmentDate: string,
  count: number,
) {
  const customer = await createCustomer();
  for (let i = 0; i < count; i++) {
    await insertAppointment({ slot, customerId: customer.id, appointmentDate, status: "CONFIRMED" });
  }
}
