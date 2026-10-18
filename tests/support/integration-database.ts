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
    // Fault-injection tests use database triggers so they can prove rollback.
    // A killed test process cannot execute its local `finally`, so remove only
    // the named, test-only artifacts before the next isolated test begins.
    // This deliberately does not touch application triggers or migrations.
    await removeOrphanedTestFaults();
    await prisma.$executeRawUnsafe(`
      TRUNCATE "StripeWebhookEvent", "PaymentProcessingException", "RateLimitCounter", "MarketingConsentEvent",
               "AppointmentEvent", "Payment", "Appointment", "Customer",
               "BookingSlot", "SalonLocation",
               "HairstyleMediaCleanupTask", "HairstyleMedia", "HairstyleVariant", "Hairstyle", "HairstyleCategory",
               "AdminSession", "AdminUser"
      CASCADE
    `);
  });

  after(async () => {
    await prisma.$disconnect();
  });
}

async function removeOrphanedTestFaults() {
  for (const [trigger, table] of [
    ["checkout_test_fault_trigger", "Payment"],
    ["checkout_test_fault_trigger", "Appointment"],
    ["checkout_test_fault_trigger", "AppointmentEvent"],
    ["public_booking_fault_trigger", "Appointment"],
    ["public_booking_fault_trigger", "AppointmentEvent"],
    ["test_fail_commit", "Appointment"],
    ["test_fail_write", "Appointment"],
    ["test_fail_write", "AppointmentEvent"],
    ["test_fail_write", "Payment"],
    ["consent_test_fault", "MarketingConsentEvent"],
  ]) {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
  }
  for (const name of ["checkout_test_fault", "public_booking_fault", "test_fail_commit", "test_fail_write", "consent_test_fault"]) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
  }
}
