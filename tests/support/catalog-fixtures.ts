import { after, before, beforeEach } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * Shared setup for database-backed catalog tests.
 * Only ever runs against the database accepted by tests/support/test-database.ts.
 */

export const integrationSkip = process.env.CATALOG_INTEGRATION_SKIP_REASON || false;

/** Registers per-file hooks: verify test DB, truncate before each test, disconnect. */
export function useCleanTestDatabase() {
  if (integrationSkip) return;

  before(async () => {
    const [{ current_database }] = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;
    if (!current_database.toLowerCase().includes("test")) {
      throw new Error("Refusing to truncate a database whose name does not contain 'test'.");
    }
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE "AppointmentEvent", "Payment", "Appointment", "Customer",
               "BookingSlot", "SalonLocation",
               "HairstyleMedia", "Hairstyle", "HairstyleCategory"
      CASCADE
    `);
  });

  after(async () => {
    await prisma.$disconnect();
  });
}

/** Creates a historical appointment that references `hairstyleId`. */
export async function createHistoricalAppointment(
  hairstyleId: string,
  hairstyleNameSnapshot: string,
) {
  const location = await prisma.salonLocation.create({
    data: { name: "Test Location", acceptsOnlineBooking: true },
  });
  const slot = await prisma.bookingSlot.create({
    data: {
      locationId: location.id,
      localStartTime: new Date("1970-01-01T11:00:00.000Z"),
      capacity: 10,
    },
  });
  const customer = await prisma.customer.create({
    data: { name: "Test Customer", email: "customer@example.test", phone: "555-0100" },
  });

  return prisma.appointment.create({
    data: {
      customerId: customer.id,
      locationId: location.id,
      bookingSlotId: slot.id,
      hairstyleId,
      appointmentDate: new Date("2026-09-01T00:00:00.000Z"),
      status: "COMPLETED",
      locationNameSnapshot: location.name,
      slotTimeSnapshot: "11:00",
      hairstyleNameSnapshot,
      totalPriceCents: 20000,
      depositAmountCents: 5000,
      balanceDueCents: 15000,
    },
  });
}
