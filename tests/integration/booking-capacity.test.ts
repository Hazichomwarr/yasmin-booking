import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import { acquireBookingHold, getSlotAvailability, listBookableSlotsForDate } from "@/lib/booking";
import { prisma } from "@/lib/prisma";

import { assertBookingError } from "../support/assertions";
import {
  NOW,
  WEEK,
  createCustomer,
  createLocation,
  fillSlot,
  insertAppointment,
  seconds,
} from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe("slot availability", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function availability(slot: { id: string; locationId: string }, now = NOW, date: string = WEEK.monday) {
    return getSlotAvailability(
      { locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: date },
      { now },
    );
  }

  it("empty slot has full capacity", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 10 }] });
    const result = await availability(slot);
    assert.deepEqual(
      [result.configuredCapacity, result.consumedCapacity, result.remainingCapacity, result.isBookable],
      [10, 0, 10, true],
    );
  });

  it("partially consumed slot", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 10 }] });
    await fillSlot(slot, WEEK.monday, 4);
    const result = await availability(slot);
    assert.deepEqual([result.consumedCapacity, result.remainingCapacity, result.isBookable], [4, 6, true]);
  });

  it("exactly full slot is unavailable", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 3 }] });
    await fillSlot(slot, WEEK.monday, 3);
    const result = await availability(slot);
    assert.deepEqual(
      [result.consumedCapacity, result.remainingCapacity, result.isBookable, result.unavailableReason],
      [3, 0, false, "CAPACITY_FULL"],
    );
  });

  it("over-consumed slot (corrupt/manual data) reports 0 remaining and leaves history untouched", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 2 }] });
    await fillSlot(slot, WEEK.monday, 4);
    const before = await prisma.appointment.findMany({ orderBy: { id: "asc" } });

    const result = await availability(slot);
    assert.deepEqual([result.consumedCapacity, result.remainingCapacity, result.isBookable], [4, 0, false]);
    assert.deepEqual(await prisma.appointment.findMany({ orderBy: { id: "asc" } }), before);
  });

  it("counts capacity per date independently", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 2 }] });
    await fillSlot(slot, WEEK.monday, 2);
    assert.equal((await availability(slot, NOW, WEEK.tuesday)).remainingCapacity, 2);
  });

  it("reports policy reasons for weekend, inactive slot, and offline location", async () => {
    const { location, slot } = await createLocation();
    assert.equal((await availability(slot, NOW, WEEK.saturday)).unavailableReason, "ONLINE_BOOKING_CLOSED_FOR_DAY");

    await prisma.bookingSlot.update({ where: { id: slot.id }, data: { isActive: false } });
    assert.equal((await availability(slot)).unavailableReason, "SLOT_NOT_BOOKABLE");

    await prisma.salonLocation.update({ where: { id: location.id }, data: { acceptsOnlineBooking: false } });
    const offline = await availability(slot);
    assert.equal(offline.unavailableReason, "LOCATION_NOT_BOOKABLE");
    assert.equal(offline.isBookable, false);
  });

  it("rejects a slot from another location", async () => {
    const { location } = await createLocation();
    const other = await createLocation({ name: "Other" });
    await assertBookingError(
      getSlotAvailability(
        { locationId: location.id, bookingSlotId: other.slot.id, appointmentDate: WEEK.monday },
        { now: NOW },
      ),
      "SLOT_NOT_FOUND",
    );
  });
});

describe("capacity status matrix (database rule)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  const matrix: [string, AppointmentStatus, Date | null, number][] = [
    ["PENDING_PAYMENT + hold in the future consumes", "PENDING_PAYMENT", at(seconds(1)), 1],
    ["PENDING_PAYMENT + hold expiring exactly now does not consume", "PENDING_PAYMENT", at(0), 0],
    ["PENDING_PAYMENT + expired hold does not consume", "PENDING_PAYMENT", at(-seconds(1)), 0],
    ["PENDING_PAYMENT + null holdExpiresAt does not consume", "PENDING_PAYMENT", null, 0],
    ["CONFIRMED consumes", "CONFIRMED", null, 1],
    ["COMPLETED consumes", "COMPLETED", null, 1],
    ["NO_SHOW consumes", "NO_SHOW", null, 1],
    ["CANCELLED does not consume", "CANCELLED", null, 0],
  ];

  for (const [label, status, holdExpiresAt, expectedConsumed] of matrix) {
    it(label, async () => {
      const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 10 }] });
      const customer = await createCustomer();
      await insertAppointment({ slot, customerId: customer.id, appointmentDate: WEEK.monday, status, holdExpiresAt });

      const result = await getSlotAvailability(
        { locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
        { now: NOW },
      );
      assert.equal(result.consumedCapacity, expectedConsumed);

      const listed = await listBookableSlotsForDate(
        { locationId: slot.locationId, appointmentDate: WEEK.monday },
        { now: NOW },
      );
      assert.equal(listed.slots[0].consumedCapacity, expectedConsumed);
    });
  }
});

describe("hold expiration boundary", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  // One-place slot, already held until NOW + 15 min by another customer.
  async function heldSlot() {
    const { location, slot } = await createLocation({ slots: [{ time: "11:00", capacity: 1 }] });
    const first = await createCustomer();
    const second = await createCustomer();
    const existing = await acquireBookingHold(
      { customerId: first.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
      { now: NOW },
    );
    const tryAt = (now: Date) =>
      acquireBookingHold(
        { customerId: second.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
        { now },
      );
    return { existing, tryAt };
  }

  it("one second before expiration the hold still owns the place", async () => {
    const { existing, tryAt } = await heldSlot();
    await assertBookingError(tryAt(new Date(existing.holdExpiresAt.getTime() - seconds(1))), "CAPACITY_FULL");
  });

  it("exactly at expiration the place is released", async () => {
    const { existing, tryAt } = await heldSlot();
    const hold = await tryAt(existing.holdExpiresAt);
    assert.equal(hold.status, "PENDING_PAYMENT");
  });

  it("after expiration the place is released and the expired hold is kept, not deleted", async () => {
    const { existing, tryAt } = await heldSlot();
    await tryAt(new Date(existing.holdExpiresAt.getTime() + seconds(1)));

    const expired = await prisma.appointment.findUniqueOrThrow({ where: { id: existing.appointmentId } });
    assert.equal(expired.status, "PENDING_PAYMENT");
    assert.equal(await prisma.appointment.count(), 2);
  });
});

describe("listBookableSlotsForDate", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("offers active slots ordered by start time with remaining capacity, from configuration", async () => {
    const { location, slots } = await createLocation({
      slots: [
        { time: "14:00", capacity: 10 },
        { time: "05:00", capacity: 10 },
        { time: "09:30", capacity: 2, isActive: false },
        { time: "11:00", capacity: 4 },
      ],
    });
    const [at1400, at0500, , at1100] = slots;
    const customer = await createCustomer();
    await fillSlot(at1100, WEEK.monday, 4);
    await insertAppointment({ slot: at0500, customerId: customer.id, appointmentDate: WEEK.monday, status: "CANCELLED" });
    await insertAppointment({
      slot: at0500,
      customerId: customer.id,
      appointmentDate: WEEK.monday,
      status: "PENDING_PAYMENT",
      holdExpiresAt: at(-seconds(60)),
    });
    await insertAppointment({
      slot: at1400,
      customerId: customer.id,
      appointmentDate: WEEK.monday,
      status: "PENDING_PAYMENT",
      holdExpiresAt: at(seconds(60)),
    });
    await insertAppointment({ slot: at1400, customerId: customer.id, appointmentDate: WEEK.monday, status: "NO_SHOW" });

    const result = await listBookableSlotsForDate({ locationId: location.id, appointmentDate: WEEK.monday }, { now: NOW });

    assert.equal(result.closedReason, null);
    assert.deepEqual(
      result.slots.map((s) => [s.startTime, s.remainingCapacity, s.isBookable]),
      [
        ["05:00", 10, true], // cancelled + expired hold release
        ["11:00", 0, false], // full, still listed
        ["14:00", 8, true], // active hold + no-show consume
      ],
    );
  });

  it("offers nothing on Saturday and Sunday, with an explicit reason", async () => {
    const { location } = await createLocation();
    for (const day of [WEEK.saturday, WEEK.sunday]) {
      const result = await listBookableSlotsForDate({ locationId: location.id, appointmentDate: day }, { now: NOW });
      assert.deepEqual([result.closedReason, result.slots], ["ONLINE_BOOKING_CLOSED_FOR_DAY", []]);
    }
  });

  it("offers nothing for inactive or offline locations", async () => {
    const inactive = await createLocation({ isActive: false });
    const offline = await createLocation({ acceptsOnlineBooking: false });
    for (const { location } of [inactive, offline]) {
      const result = await listBookableSlotsForDate({ locationId: location.id, appointmentDate: WEEK.monday }, { now: NOW });
      assert.deepEqual([result.closedReason, result.slots], ["LOCATION_NOT_BOOKABLE", []]);
    }
  });

  it("throws for an unknown location or malformed date", async () => {
    const { location } = await createLocation();
    await assertBookingError(
      listBookableSlotsForDate({ locationId: "missing", appointmentDate: WEEK.monday }, { now: NOW }),
      "LOCATION_NOT_FOUND",
    );
    await assertBookingError(
      listBookableSlotsForDate({ locationId: location.id, appointmentDate: "next monday" }, { now: NOW }),
      "INVALID_APPOINTMENT_DATE",
    );
  });
});
