import { after, before, beforeEach } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * Shared hooks for database-backed tests.
 * Only ever runs against the database accepted by tests/support/test-database.ts.
 */

export const integrationSkip = process.env.INTEGRATION_SKIP_REASON || false;

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
