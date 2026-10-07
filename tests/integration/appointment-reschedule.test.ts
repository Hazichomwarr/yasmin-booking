import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  listAppointmentEvents,
  rescheduleAppointment,
  type RescheduledEventDetails,
} from "@/lib/booking";
import { createCategory, createHairstyle, deactivateHairstyle, updateHairstyle } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { assertBookingError } from "../support/assertions";
import {
  NOW,
  WEEK,
  consumedIn,
  createAppointmentIn,
  createLocation,
  fillSlot,
  withFailingWrites,
} from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("rescheduling a confirmed appointment", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  /** Location with 11:00 and 14:00 slots; one CONFIRMED appointment Monday 11:00. */
  async function setup(options: { capacity?: number } = {}) {
    const { location, slots } = await createLocation({
      name: "Test Street",
      slots: [
        { time: "11:00", capacity: options.capacity ?? 10 },
        { time: "14:00", capacity: options.capacity ?? 10 },
      ],
    });
    const [at1100, at1400] = slots;
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });
    const appointment = await createAppointmentIn({
      slot: at1100,
      appointmentDate: WEEK.monday,
      hairstyle,
      customerNotes: "Waist length",
      preferredStylistName: "Aisha",
    });
    return { location, at1100, at1400, hairstyle, appointment };
  }

  const move = (appointmentId: string, locationId: string, bookingSlotId: string, appointmentDate: string) =>
    rescheduleAppointment({ appointmentId, locationId, bookingSlotId, appointmentDate }, { now: NOW });

  it("moves Monday 11:00 → Tuesday 14:00: current fields updated, history keeps the original", async () => {
    const { location, at1100, at1400, hairstyle, appointment } = await setup();

    const result = await move(appointment.id, location.id, at1400.id, WEEK.tuesday);

    assert.equal(result.changed, true);
    assert.equal(result.appointment.appointmentDate, WEEK.tuesday);
    assert.equal(result.appointment.bookingSlotId, at1400.id);
    assert.equal(result.appointment.slotTimeSnapshot, "14:00");
    assert.equal(result.appointment.locationNameSnapshot, "Test Street");
    assert.equal(result.appointment.status, "CONFIRMED");

    // Unchanged: hairstyle, stylist, notes, money, customer.
    assert.equal(result.appointment.hairstyleId, hairstyle.id);
    assert.equal(result.appointment.hairstyleNameSnapshot, "Knotless");
    assert.equal(result.appointment.preferredStylistName, "Aisha");
    assert.equal(result.appointment.customerNotes, "Waist length");
    assert.equal(result.appointment.customerId, appointment.customerId);
    assert.deepEqual(
      [result.appointment.totalPriceCents, result.appointment.depositAmountCents, result.appointment.balanceDueCents],
      [20000, 4000, 16000],
    );

    const [event] = await listAppointmentEvents(appointment.id);
    assert.equal(event.type, "RESCHEDULED");
    assert.deepEqual(event.details, {
      schemaVersion: 1,
      before: {
        locationId: location.id,
        locationName: "Test Street",
        timeZone: "America/New_York",
        bookingSlotId: at1100.id,
        appointmentDate: WEEK.monday,
        slotTime: "11:00",
      },
      after: {
        locationId: location.id,
        locationName: "Test Street",
        timeZone: "America/New_York",
        bookingSlotId: at1400.id,
        appointmentDate: WEEK.tuesday,
        slotTime: "14:00",
      },
    });

    assert.equal(await consumedIn(at1100.id, WEEK.monday), 0);
    assert.equal(await consumedIn(at1400.id, WEEK.tuesday), 1);
  });

  it("same slot, different date moves the capacity bucket", async () => {
    const { location, at1100, appointment } = await setup({ capacity: 1 });
    await move(appointment.id, location.id, at1100.id, WEEK.wednesday);
    assert.equal(await consumedIn(at1100.id, WEEK.monday), 0);
    assert.equal(await consumedIn(at1100.id, WEEK.wednesday), 1);
  });

  it("different slot, same date", async () => {
    const { location, at1100, at1400, appointment } = await setup({ capacity: 1 });
    const result = await move(appointment.id, location.id, at1400.id, WEEK.monday);
    assert.equal(result.appointment.slotTimeSnapshot, "14:00");
    assert.equal(await consumedIn(at1100.id, WEEK.monday), 0);
    assert.equal(await consumedIn(at1400.id, WEEK.monday), 1);
  });

  it("moves to another location, using its name for the new snapshot", async () => {
    const { at1100, appointment } = await setup();
    const other = await createLocation({ name: "Other Street", slots: [{ time: "05:00" }] });

    const result = await move(appointment.id, other.location.id, other.slot.id, WEEK.thursday);

    assert.equal(result.appointment.locationId, other.location.id);
    assert.equal(result.appointment.locationNameSnapshot, "Other Street");
    assert.equal(result.appointment.slotTimeSnapshot, "05:00");
    const [event] = await listAppointmentEvents(appointment.id);
    const details = event.details as RescheduledEventDetails;
    assert.equal(details.before.locationName, "Test Street");
    assert.equal(details.after.locationName, "Other Street");
    assert.equal(await consumedIn(at1100.id, WEEK.monday), 0);
  });

  it("identical destination is a no-op: no write, no event", async () => {
    const { location, at1100, appointment } = await setup();
    const result = await move(appointment.id, location.id, at1100.id, WEEK.monday);

    assert.equal(result.changed, false);
    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), appointment);
    assert.deepEqual(await listAppointmentEvents(appointment.id), []);
  });

  it("a destination full on that date → CAPACITY_FULL, original untouched, no event", async () => {
    const { location, at1400, appointment } = await setup({ capacity: 2 });
    await fillSlot(at1400, WEEK.tuesday, 2);

    await assertBookingError(move(appointment.id, location.id, at1400.id, WEEK.tuesday), "CAPACITY_FULL");

    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), appointment);
    assert.deepEqual(await listAppointmentEvents(appointment.id), []);
  });

  it("rejects inactive slot, offline location, foreign slot, weekend, and past dates — original untouched", async () => {
    const { location, at1100, at1400, appointment } = await setup();
    const other = await createLocation({ name: "Other" });
    const offline = await createLocation({ name: "Offline", acceptsOnlineBooking: false });
    await prisma.bookingSlot.update({ where: { id: at1400.id }, data: { isActive: false } });

    await assertBookingError(move(appointment.id, location.id, at1400.id, WEEK.tuesday), "SLOT_NOT_BOOKABLE");
    await assertBookingError(move(appointment.id, offline.location.id, offline.slot.id, WEEK.tuesday), "LOCATION_NOT_BOOKABLE");
    await assertBookingError(move(appointment.id, location.id, other.slot.id, WEEK.tuesday), "SLOT_NOT_FOUND");
    await assertBookingError(move(appointment.id, location.id, at1100.id, WEEK.saturday), "ONLINE_BOOKING_CLOSED_FOR_DAY");
    await assertBookingError(move(appointment.id, location.id, at1100.id, "2027-02-26"), "INVALID_APPOINTMENT_DATE");
    await assertBookingError(move(appointment.id, "missing", at1100.id, WEEK.tuesday), "LOCATION_NOT_FOUND");

    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), appointment);
    assert.deepEqual(await listAppointmentEvents(appointment.id), []);
  });

  it("past-date policy uses the DESTINATION location's timezone", async () => {
    const { appointment } = await setup();
    const tokyo = await createLocation({ name: "Tokyo", timeZone: "Asia/Tokyo" });
    const newYork = await createLocation({ name: "New York" });
    // Tue 2027-03-09 22:30 in New York = Wed 12:30 in Tokyo.
    const now = new Date("2027-03-10T03:30:00.000Z");
    const moveAt = (loc: { location: { id: string }; slot: { id: string } }, date: string) =>
      rescheduleAppointment(
        { appointmentId: appointment.id, locationId: loc.location.id, bookingSlotId: loc.slot.id, appointmentDate: date },
        { now },
      );

    await assertBookingError(moveAt(tokyo, WEEK.tuesday), "INVALID_APPOINTMENT_DATE");
    const result = await moveAt(newYork, WEEK.tuesday);
    assert.equal(result.appointment.appointmentDate, WEEK.tuesday);
  });

  it("only CONFIRMED appointments can be rescheduled", async () => {
    const { location, at1100, at1400 } = await setup();
    for (const status of ["PENDING_PAYMENT", "COMPLETED", "CANCELLED", "NO_SHOW"] as const) {
      const appointment = await createAppointmentIn({ slot: at1100, appointmentDate: WEEK.monday, status });
      await assertBookingError(move(appointment.id, location.id, at1400.id, WEEK.tuesday), "APPOINTMENT_NOT_RESCHEDULABLE");
    }
    await assertBookingError(move("missing", location.id, at1400.id, WEEK.tuesday), "APPOINTMENT_NOT_FOUND");
  });

  it("catalog rename/deactivation after booking does not change the hairstyle snapshot on reschedule", async () => {
    const { location, at1400, hairstyle, appointment } = await setup();
    await updateHairstyle(hairstyle.id, { name: "Small Knotless" });
    await deactivateHairstyle(hairstyle.id);

    const result = await move(appointment.id, location.id, at1400.id, WEEK.tuesday);
    assert.equal(result.appointment.hairstyleNameSnapshot, "Knotless");
    assert.equal(result.appointment.hairstyleId, hairstyle.id);
  });

  it("if the RESCHEDULED event insert fails, the move rolls back", async () => {
    const { location, at1400, appointment } = await setup();
    await withFailingWrites("AppointmentEvent", "INSERT", async () => {
      await assert.rejects(move(appointment.id, location.id, at1400.id, WEEK.tuesday), /forced test failure/);
    });
    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), appointment);
    assert.equal(await consumedIn(at1400.id, WEEK.tuesday), 0);
  });
});
