import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { resolveBookingAccess } from "@/lib/booking/access";
import { BookingError } from "@/lib/booking/errors";
import { createPublicBooking, PublicBookingValidationError } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";

import { WEEK, createLocation, publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

async function input(capacity = 10) {
  const { location, slot } = await publicBookingPlace({ capacity });
  const category = await prisma.hairstyleCategory.create({ data: { name: `Public category ${slot.id}`, slug: `public-category-${slot.id}` } });
  const hairstyle = await prisma.hairstyle.create({ data: { categoryId: category.id, name: "Public booking style", slug: `public-style-${slot.id}`, priceCents: 22_000 } });
  return { name: "Yasmin Customer", email: "CUSTOMER@example.test", phone: "+1 (555) 010-0100", locationId: location.id, bookingSlotId: slot.id, appointmentDate: upcomingPublicBookingDate(), hairstyleId: hairstyle.id };
}
async function fault(sql: string, fn: () => Promise<void>) {
  await prisma.$executeRawUnsafe("CREATE OR REPLACE FUNCTION public_booking_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'public booking fault'; END; $$");
  await prisma.$executeRawUnsafe(sql);
  try { await fn(); } finally {
    for (const table of ["Appointment", "AppointmentEvent"]) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS public_booking_fault_trigger ON "${table}"`);
    await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS public_booking_fault()");
  }
}

describe("public booking creation", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  it("creates Customer, hold, hashed credential and CREATED event atomically", async () => {
    const result = await createPublicBooking(await input());
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: result.booking.appointmentId }, include: { customer: true, events: true } });
    assert.equal(appointment.status, "PENDING_PAYMENT"); assert.equal(await prisma.customer.count(), 1); assert.equal(appointment.events.length, 1); assert.equal(appointment.events[0].type, "CREATED");
    assert.equal(appointment.accessTokenHash, createHash("sha256").update(result.accessToken).digest("hex")); assert.equal(appointment.customer.email, "customer@example.test");
  });
  it("resolves the one-time token and never persists plaintext", async () => {
    const result = await createPublicBooking(await input()); const grant = await resolveBookingAccess(result.accessToken);
    const text = JSON.stringify(await Promise.all([prisma.appointment.findMany(), prisma.customer.findMany(), prisma.appointmentEvent.findMany(), prisma.payment.findMany()]));
    assert.equal(grant.appointmentId, result.booking.appointmentId); assert.equal(text.includes(result.accessToken), false);
  });
  it("allows only one capacity-one contender and leaves no orphan customer", async () => {
    const base = await input(1); const [a, b] = await Promise.allSettled([createPublicBooking(base), createPublicBooking({ ...base, email: "two@example.test" })]);
    assert.equal([a, b].filter((x) => x.status === "fulfilled").length, 1); assert.equal(await prisma.customer.count(), 1); assert.equal(await prisma.appointment.count(), 1);
    const failed = [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult; assert.ok(failed.reason instanceof BookingError); assert.equal(failed.reason.code, "CAPACITY_FULL");
  });
  it("rolls back Customer when Appointment insert fails", async () => {
    await fault('CREATE TRIGGER public_booking_fault_trigger BEFORE INSERT ON "Appointment" FOR EACH ROW EXECUTE FUNCTION public_booking_fault()', async () => assert.rejects(createPublicBooking(await input()), /public booking fault/));
    assert.equal(await prisma.customer.count(), 0); assert.equal(await prisma.appointment.count(), 0);
  });
  it("rolls back Customer and Appointment when access issuance fails", async () => {
    await fault('CREATE TRIGGER public_booking_fault_trigger BEFORE UPDATE OF "accessTokenHash" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION public_booking_fault()', async () => assert.rejects(createPublicBooking(await input()), /public booking fault/));
    assert.equal(await prisma.customer.count(), 0); assert.equal(await prisma.appointment.count(), 0);
  });
  it("rolls back all writes when CREATED append fails", async () => {
    await fault('CREATE TRIGGER public_booking_fault_trigger BEFORE INSERT ON "AppointmentEvent" FOR EACH ROW EXECUTE FUNCTION public_booking_fault()', async () => assert.rejects(createPublicBooking(await input()), /public booking fault/));
    assert.equal(await prisma.customer.count(), 0); assert.equal(await prisma.appointment.count(), 0); assert.equal(await prisma.appointmentEvent.count(), 0);
  });
  it("stores a US-formatted phone exactly as typed (trimmed only)", async () => {
    const result = await createPublicBooking({ ...(await input()), phone: "  (555) 010-0100 " });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: result.booking.appointmentId }, include: { customer: true } });
    assert.equal(appointment.customer.phone, "(555) 010-0100");
  });
  it("rejects invalid and forbidden input before writes", async () => {
    const base = await input(); for (const value of [{ ...base, email: "bad" }, { ...base, phone: "x" }, { ...base, appointmentDate: "2027-02-30" }, { ...base, name: "x".repeat(121) }, { ...base, emailMarketingConsent: "yes" }, { ...base, customerId: "forbidden" }]) await assert.rejects(createPublicBooking(value), PublicBookingValidationError);
    assert.equal(await prisma.customer.count(), 0); assert.equal(await prisma.appointment.count(), 0);
  });
  it("requires a bookable hairstyle before creating any customer or hold", async () => {
    const base = await input();
    const missingStyle: Record<string, unknown> = { ...base };
    delete missingStyle.hairstyleId;
    await assert.rejects(createPublicBooking(missingStyle), PublicBookingValidationError);
    assert.equal(await prisma.customer.count(), 0);
    assert.equal(await prisma.appointment.count(), 0);
  });
  it("returns only the public booking allow-list", async () => {
    const result = await createPublicBooking(await input());
    assert.deepEqual(Object.keys(result.booking).sort(), ["appointmentDate", "appointmentId", "balanceDueCents", "depositAmountCents", "holdExpiresAt", "locationName", "slotTime", "totalPriceCents"].sort());
    assert.deepEqual([result.booking.totalPriceCents, result.booking.depositAmountCents, result.booking.balanceDueCents], [22_000, 4_000, 18_000]);
  });
  it("keeps email and SMS marketing consent independent", async () => {
    const cases = [[false, false, false, false], [true, false, true, false], [false, true, false, true], [true, true, true, true]] as const;
    for (const [email, sms, hasEmail, hasSms] of cases) {
      const result = await createPublicBooking({ ...(await input()), emailMarketingConsent: email, smsMarketingConsent: sms });
      const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: result.booking.appointmentId }, include: { customer: true } });
      assert.equal(appointment.customer.emailMarketingAt !== null, hasEmail); assert.equal(appointment.customer.smsMarketingAt !== null, hasSms);
    }
  });
  it("enforces active location, active slot, matching location, weekday, and timezone policy", async () => {
    const inactiveLocation = await createLocation({ isActive: false, acceptsOnlineBooking: false });
    await assert.rejects(createPublicBooking({ ...(await input()), locationId: inactiveLocation.location.id, bookingSlotId: inactiveLocation.slot.id }), BookingError);
    const online = await input();
    const inactiveSlot = await prisma.bookingSlot.create({ data: { locationId: online.locationId, localStartTime: new Date("1970-01-01T16:00:00.000Z"), capacity: 10, isActive: false } });
    await assert.rejects(createPublicBooking({ ...online, bookingSlotId: inactiveSlot.id }), (e: unknown) => e instanceof BookingError && e.code === "SLOT_NOT_BOOKABLE");
    const other = await createLocation({ acceptsOnlineBooking: false });
    await assert.rejects(createPublicBooking({ ...online, bookingSlotId: other.slot.id }), (e: unknown) => e instanceof BookingError && e.code === "SLOT_NOT_FOUND");
    await assert.rejects(createPublicBooking({ ...(await input()), appointmentDate: WEEK.saturday }), BookingError);
    await assert.rejects(createPublicBooking({ ...(await input()), appointmentDate: WEEK.sunday }), BookingError);
  });
  it("reads its database clock only after acquiring the BookingSlot lock", async () => {
    const base = await input();
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BookingSlot" WHERE "id" = ${base.bookingSlotId} FOR UPDATE`;
      acquired();
      await locked;
    });
    await acquiredLock;
    const booking = createPublicBooking(base);
    // PostgreSQL sees the waiting transaction; it cannot have read the post-lock clock yet.
    let waiting = false;
    for (let i = 0; i < 40; i += 1) {
      const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%BookingSlot%') AS waiting`;
      if (rows[0].waiting) { waiting = true; break; }
    }
    assert.equal(waiting, true);
    const [{ now: releasedAt }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    release(); await blocker;
    const result = await booking;
    assert.ok(result.booking.holdExpiresAt.getTime() >= releasedAt.getTime() + 15 * 60_000);
  });
});
