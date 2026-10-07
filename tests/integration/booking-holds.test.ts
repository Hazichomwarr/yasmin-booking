import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { acquireBookingHold, listBookableSlotsForDate } from "@/lib/booking";
import { createCategory, createHairstyle, deactivateCategory, deactivateHairstyle, updateHairstyle } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { assertBookingError } from "../support/assertions";
import { NOW, WEEK, createCustomer, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("booking hold policy", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function bookable() {
    const { location, slot } = await createLocation();
    const customer = await createCustomer();
    const hold = (appointmentDate: string, extra: Partial<Parameters<typeof acquireBookingHold>[0]> = {}) =>
      acquireBookingHold(
        { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate, ...extra },
        { now: NOW },
      );
    return { location, slot, customer, hold };
  }

  it("accepts Monday through Friday", async () => {
    const { hold } = await bookable();
    for (const day of [WEEK.monday, WEEK.tuesday, WEEK.wednesday, WEEK.thursday, WEEK.friday]) {
      const result = await hold(day);
      assert.equal(result.appointmentDate, day);
    }
  });

  it("rejects Saturday and Sunday without writing anything", async () => {
    const { hold } = await bookable();
    await assertBookingError(hold(WEEK.saturday), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    await assertBookingError(hold(WEEK.sunday), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    assert.equal(await prisma.appointment.count(), 0);
  });

  it("rejects invalid and certainly-past dates", async () => {
    const { hold } = await bookable();
    await assertBookingError(hold("2027-02-30"), "INVALID_APPOINTMENT_DATE");
    await assertBookingError(hold("2027-02-26"), "INVALID_APPOINTMENT_DATE"); // last Friday in New York
  });

  it("rejects an inactive location", async () => {
    const { location, hold } = await bookable();
    await prisma.salonLocation.update({ where: { id: location.id }, data: { isActive: false } });
    await assertBookingError(hold(WEEK.monday), "LOCATION_NOT_BOOKABLE");
  });

  it("rejects an active location that does not accept online booking", async () => {
    const { location, hold } = await bookable();
    await prisma.salonLocation.update({ where: { id: location.id }, data: { acceptsOnlineBooking: false } });
    await assertBookingError(hold(WEEK.monday), "LOCATION_NOT_BOOKABLE");
  });

  it("rejects an inactive slot", async () => {
    const { slot, hold } = await bookable();
    await prisma.bookingSlot.update({ where: { id: slot.id }, data: { isActive: false } });
    await assertBookingError(hold(WEEK.monday), "SLOT_NOT_BOOKABLE");
  });

  it("rejects a slot that belongs to another location", async () => {
    const { hold } = await bookable();
    const other = await createLocation({ name: "Other Street" });

    await assertBookingError(hold(WEEK.monday, { bookingSlotId: other.slot.id }), "SLOT_NOT_FOUND");
    assert.equal(await prisma.appointment.count(), 0);
  });

  it("rejects unknown location, slot, and customer", async () => {
    const { hold } = await bookable();
    await assertBookingError(hold(WEEK.monday, { locationId: "missing" }), "LOCATION_NOT_FOUND");
    await assertBookingError(hold(WEEK.monday, { bookingSlotId: "missing" }), "SLOT_NOT_FOUND");
    await assertBookingError(hold(WEEK.monday, { customerId: "missing" }), "CUSTOMER_NOT_FOUND");
  });

  it("accepts no hairstyle", async () => {
    const { hold } = await bookable();
    const result = await hold(WEEK.monday, { hairstyleId: null });
    assert.equal(result.hairstyleId, null);
    assert.equal(result.hairstyleNameSnapshot, null);
  });

  it("accepts an active hairstyle in an active category and snapshots its name", async () => {
    const { hold } = await bookable();
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    const result = await hold(WEEK.monday, { hairstyleId: hairstyle.id });
    assert.equal(result.hairstyleId, hairstyle.id);
    assert.equal(result.hairstyleNameSnapshot, "Knotless");
  });

  it("rejects an inactive hairstyle, a hairstyle in an inactive category, and an unknown one", async () => {
    const { hold } = await bookable();
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const inactive = await createHairstyle({ categoryId: category.id, name: "Old", slug: "old", isActive: false });
    const hiddenCategory = await createCategory({ name: "Hidden", slug: "hidden" });
    const underHidden = await createHairstyle({ categoryId: hiddenCategory.id, name: "Twist", slug: "twist" });
    await deactivateCategory(hiddenCategory.id);

    await assertBookingError(hold(WEEK.monday, { hairstyleId: inactive.id }), "HAIRSTYLE_NOT_AVAILABLE");
    await assertBookingError(hold(WEEK.monday, { hairstyleId: underHidden.id }), "HAIRSTYLE_NOT_AVAILABLE");
    await assertBookingError(hold(WEEK.monday, { hairstyleId: "missing" }), "HAIRSTYLE_NOT_AVAILABLE");
    assert.equal(await prisma.appointment.count(), 0);
  });
});

describe("booking hold snapshots", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("writes the PENDING_PAYMENT hold with booking-time snapshots and V1 money", async () => {
    const { location, slot } = await createLocation({ name: "Test Street", slots: [{ time: "05:00" }] });
    const customer = await createCustomer();

    const hold = await acquireBookingHold(
      {
        customerId: customer.id,
        locationId: location.id,
        bookingSlotId: slot.id,
        appointmentDate: WEEK.tuesday,
        preferredStylistName: "  Aisha ",
        customerNotes: "   ",
      },
      { now: NOW },
    );

    assert.equal(hold.status, "PENDING_PAYMENT");
    assert.equal(hold.holdExpiresAt.toISOString(), "2027-03-01T15:15:00.000Z");
    assert.equal(hold.locationNameSnapshot, "Test Street");
    assert.equal(hold.slotTimeSnapshot, "05:00");
    assert.equal(hold.preferredStylistName, "Aisha");
    assert.equal(hold.customerNotes, null);
    assert.equal(hold.totalPriceCents, 20000);
    assert.equal(hold.depositAmountCents, 4000);
    assert.equal(hold.balanceDueCents, 16000);

    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
    assert.equal(stored.appointmentDate.toISOString(), "2027-03-09T00:00:00.000Z");
    assert.equal(stored.status, "PENDING_PAYMENT");
    assert.equal(await prisma.payment.count(), 0);
  });

  it("snapshots do not change when location, slot, or hairstyle configuration changes later", async () => {
    const { location, slot } = await createLocation({ name: "Test Street", slots: [{ time: "11:00" }] });
    const customer = await createCustomer();
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    const hold = await acquireBookingHold(
      {
        customerId: customer.id,
        locationId: location.id,
        bookingSlotId: slot.id,
        appointmentDate: WEEK.monday,
        hairstyleId: hairstyle.id,
      },
      { now: NOW },
    );
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });

    await prisma.salonLocation.update({ where: { id: location.id }, data: { name: "Renamed Street" } });
    await prisma.bookingSlot.update({
      where: { id: slot.id },
      data: { localStartTime: new Date("1970-01-01T12:30:00.000Z"), capacity: 4 },
    });
    await updateHairstyle(hairstyle.id, { name: "Small Knotless" });
    await deactivateHairstyle(hairstyle.id);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
    assert.deepEqual(after, before);
    assert.equal(after.locationNameSnapshot, "Test Street");
    assert.equal(after.slotTimeSnapshot, "11:00");
    assert.equal(after.hairstyleNameSnapshot, "Knotless");
  });
});

describe("booking dates survive any process timezone", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  for (const tz of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
    it(`stores and reads back the salon date and slot time unchanged in ${tz}`, async () => {
      process.env.TZ = tz;
      const { location, slot } = await createLocation({ slots: [{ time: "05:00" }] });
      const customer = await createCustomer();

      const hold = await acquireBookingHold(
        { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
        { now: NOW },
      );
      const [row] = await prisma.$queryRaw<{ d: string; weekday: number }[]>`
        SELECT to_char("appointmentDate", 'YYYY-MM-DD') AS d,
               EXTRACT(ISODOW FROM "appointmentDate")::int AS weekday
        FROM "Appointment" WHERE "id" = ${hold.appointmentId}
      `;

      assert.equal(hold.appointmentDate, WEEK.monday);
      assert.equal(hold.slotTimeSnapshot, "05:00");
      assert.equal(row.d, WEEK.monday);
      assert.equal(row.weekday, 1); // PostgreSQL agrees: Monday
    });
  }
});

describe("location timezone defines the booking calendar", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  // Tue 2027-03-09 22:30 in New York (EST); already Wed 2027-03-10 in UTC and Tokyo.
  const tuesdayNightInNewYork = new Date("2027-03-10T03:30:00.000Z");

  async function holdAt(timeZone: string, appointmentDate: string) {
    const { location, slot } = await createLocation({ timeZone });
    const customer = await createCustomer();
    return acquireBookingHold(
      { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate },
      { now: tuesdayNightInNewYork },
    );
  }

  it("a New York location accepts its same-day booking although UTC is already tomorrow", async () => {
    const hold = await holdAt("America/New_York", WEEK.tuesday);
    assert.equal(hold.appointmentDate, WEEK.tuesday);
  });

  it("a New York location rejects its yesterday", async () => {
    await assertBookingError(holdAt("America/New_York", WEEK.monday), "INVALID_APPOINTMENT_DATE");
  });

  it("a Tokyo location at the same instant treats that Tuesday as past", async () => {
    await assertBookingError(holdAt("Asia/Tokyo", WEEK.tuesday), "INVALID_APPOINTMENT_DATE");
    assert.equal((await holdAt("Asia/Tokyo", WEEK.wednesday)).appointmentDate, WEEK.wednesday);
  });

  it("availability uses the same calendar", async () => {
    const { location } = await createLocation({ timeZone: "America/New_York" });
    const read = (appointmentDate: string) =>
      listBookableSlotsForDate({ locationId: location.id, appointmentDate }, { now: tuesdayNightInNewYork });

    assert.equal((await read(WEEK.tuesday)).closedReason, null);
    assert.deepEqual([(await read(WEEK.monday)).closedReason, (await read(WEEK.monday)).slots], ["INVALID_APPOINTMENT_DATE", []]);
  });

  it("a misconfigured timezone fails explicitly and writes nothing", async () => {
    await assertBookingError(holdAt("EST", WEEK.thursday), "LOCATION_TIME_ZONE_INVALID");
    const { location } = await createLocation({ timeZone: "+05:00" });
    await assertBookingError(
      listBookableSlotsForDate({ locationId: location.id, appointmentDate: WEEK.thursday }, { now: NOW }),
      "LOCATION_TIME_ZONE_INVALID",
    );
    assert.equal(await prisma.appointment.count(), 0);
  });
});
