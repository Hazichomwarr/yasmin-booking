import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import {
  acquireBookingHold,
  cancelAppointment,
  completeAppointment,
  getSlotAvailability,
  listAppointmentEvents,
  markAppointmentNoShow,
  updateAppointmentCustomerNotes,
} from "@/lib/booking";
import { prisma } from "@/lib/prisma";

import { assertBookingError } from "../support/assertions";
import {
  NOW,
  WEEK,
  createAppointmentIn,
  createCustomer,
  createLocation,
  seconds,
  withFailingWrites,
} from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const commands = {
  cancel: cancelAppointment,
  complete: completeAppointment,
  markNoShow: markAppointmentNoShow,
} as const;

const targetOf = { cancel: "CANCELLED", complete: "COMPLETED", markNoShow: "NO_SHOW" } as const;

async function eventTypes(appointmentId: string) {
  return (await listAppointmentEvents(appointmentId)).map((e) => e.type);
}

describe("appointment lifecycle matrix (database)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  type Expected = "apply" | "no-op" | "reject";
  const matrix: [AppointmentStatus, keyof typeof commands, Expected][] = [
    ["PENDING_PAYMENT", "cancel", "apply"],
    ["PENDING_PAYMENT", "complete", "reject"],
    ["PENDING_PAYMENT", "markNoShow", "reject"],
    ["CONFIRMED", "cancel", "apply"],
    ["CONFIRMED", "complete", "apply"],
    ["CONFIRMED", "markNoShow", "apply"],
    ["COMPLETED", "complete", "no-op"],
    ["COMPLETED", "cancel", "reject"],
    ["COMPLETED", "markNoShow", "reject"],
    ["CANCELLED", "cancel", "no-op"],
    ["CANCELLED", "complete", "reject"],
    ["CANCELLED", "markNoShow", "reject"],
    ["NO_SHOW", "markNoShow", "no-op"],
    ["NO_SHOW", "complete", "reject"],
    ["NO_SHOW", "cancel", "reject"],
  ];

  for (const [status, command, expected] of matrix) {
    it(`${status} + ${command} → ${expected}`, async () => {
      const { slot } = await createLocation();
      const appointment = await createAppointmentIn({
        slot,
        appointmentDate: WEEK.monday,
        status,
        holdExpiresAt: status === "PENDING_PAYMENT" ? new Date(NOW.getTime() + seconds(600)) : null,
      });
      const before = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });

      if (expected === "reject") {
        await assertBookingError(commands[command](appointment.id), "INVALID_APPOINTMENT_TRANSITION");
        assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), before);
        assert.deepEqual(await eventTypes(appointment.id), []);
        return;
      }

      const result = await commands[command](appointment.id);
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });

      if (expected === "no-op") {
        assert.equal(result.changed, false);
        assert.deepEqual(after, before); // not even updatedAt moves
        assert.deepEqual(await eventTypes(appointment.id), []);
      } else {
        assert.equal(result.changed, true);
        assert.equal(after.status, targetOf[command]);
        const events = await listAppointmentEvents(appointment.id);
        assert.deepEqual(events.map((e) => e.type), [targetOf[command]]);
        assert.deepEqual(events[0].details, {
          schemaVersion: 1,
          fromStatus: status,
          toStatus: targetOf[command],
        });
      }
    });
  }

  it("repeating a successful command is idempotent: one event only", async () => {
    const { slot } = await createLocation();
    for (const command of ["cancel", "complete", "markNoShow"] as const) {
      const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
      assert.equal((await commands[command](appointment.id)).changed, true);
      assert.equal((await commands[command](appointment.id)).changed, false);
      assert.equal((await commands[command](appointment.id)).appointment.status, targetOf[command]);
      assert.deepEqual(await eventTypes(appointment.id), [targetOf[command]]);
    }
  });

  it("unknown appointment → APPOINTMENT_NOT_FOUND", async () => {
    await assertBookingError(cancelAppointment("missing"), "APPOINTMENT_NOT_FOUND");
    await assertBookingError(listAppointmentEvents("missing"), "APPOINTMENT_NOT_FOUND");
  });
});

describe("lifecycle preserves the appointment, money, payments, and history", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("cancelling an active hold releases its place immediately and keeps the row", async () => {
    const { location, slot } = await createLocation({ slots: [{ time: "11:00", capacity: 1 }] });
    const customer = await createCustomer();
    const hold = await acquireBookingHold(
      { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
      { now: NOW },
    );
    const read = () =>
      getSlotAvailability({ locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday }, { now: NOW });
    assert.equal((await read()).remainingCapacity, 0);

    await cancelAppointment(hold.appointmentId);

    assert.equal((await read()).remainingCapacity, 1);
    const kept = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.appointmentId } });
    assert.equal(kept.status, "CANCELLED");
    assert.deepEqual(await eventTypes(hold.appointmentId), ["CREATED", "CANCELLED"]);
  });

  it("cancel / complete / no-show change only status (and updatedAt); payments and customer untouched", async () => {
    const { slot } = await createLocation();
    for (const command of ["cancel", "complete", "markNoShow"] as const) {
      const appointment = await createAppointmentIn({
        slot,
        appointmentDate: WEEK.monday,
        hairstyle: null,
        customerNotes: "Waist length",
        preferredStylistName: "Aisha",
      });
      const payment = await prisma.payment.create({
        data: {
          appointmentId: appointment.id,
          provider: "STRIPE",
          purpose: "BOOKING_DEPOSIT",
          status: "PAID",
          amountCents: 4000,
          paidAt: NOW,
        },
      });
      const customer = await prisma.customer.findUniqueOrThrow({ where: { id: appointment.customerId } });

      await commands[command](appointment.id);

      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      const { status: _s, updatedAt: _u, ...unchangedAfter } = after;
      const { status: _s0, updatedAt: _u0, ...unchangedBefore } = appointment;
      assert.deepEqual(unchangedAfter, unchangedBefore);
      assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }), payment);
      assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }), customer);
    }
  });

  it("acquireBookingHold writes a CREATED event describing the hold", async () => {
    const { location, slot } = await createLocation({ name: "Test Street", slots: [{ time: "05:00" }] });
    const customer = await createCustomer();
    const hold = await acquireBookingHold(
      { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.friday },
      { now: NOW },
    );

    const [created] = await listAppointmentEvents(hold.appointmentId);
    assert.equal(created.type, "CREATED");
    assert.deepEqual(created.details, {
      schemaVersion: 1,
      status: "PENDING_PAYMENT",
      holdExpiresAt: "2027-03-01T15:15:00.000Z",
      schedule: {
        locationId: location.id,
        locationName: "Test Street",
        timeZone: "America/New_York",
        bookingSlotId: slot.id,
        appointmentDate: WEEK.friday,
        slotTime: "05:00",
      },
      hairstyleId: null,
      hairstyleNameSnapshot: null,
      pricing: { totalPriceCents: 20000, depositAmountCents: 4000, balanceDueCents: 16000 },
    });
  });

  it("a failed hold acquisition writes no event", async () => {
    const { location, slot } = await createLocation({ slots: [{ time: "11:00", capacity: 0 }] });
    const customer = await createCustomer();
    await assertBookingError(
      acquireBookingHold(
        { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
        { now: NOW },
      ),
      "CAPACITY_FULL",
    );
    assert.equal(await prisma.appointmentEvent.count(), 0);
  });
});

describe("customer notes updates", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("records NOTE_UPDATED with old and new values; unchanged value is a no-op", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday, customerNotes: "Shoulder length" });

    const first = await updateAppointmentCustomerNotes(appointment.id, "  Waist length ");
    assert.equal(first.changed, true);
    assert.equal(first.appointment.customerNotes, "Waist length");

    assert.equal((await updateAppointmentCustomerNotes(appointment.id, "Waist length")).changed, false);
    await updateAppointmentCustomerNotes(appointment.id, "   ");

    const events = await listAppointmentEvents(appointment.id);
    assert.deepEqual(
      events.map((e) => e.details),
      [
        { schemaVersion: 1, field: "customerNotes", before: "Shoulder length", after: "Waist length" },
        { schemaVersion: 1, field: "customerNotes", before: "Waist length", after: null },
      ],
    );
    assert.ok(events.every((e) => e.type === "NOTE_UPDATED"));
  });

  it("is rejected once the appointment is terminal", async () => {
    const { slot } = await createLocation();
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW"] as const) {
      const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday, status });
      await assertBookingError(updateAppointmentCustomerNotes(appointment.id, "x"), "APPOINTMENT_NOT_EDITABLE");
    }
  });
});

describe("audit history ordering and append-only behavior", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("lists events oldest first, with strictly increasing timestamps, never rewriting earlier ones", async () => {
    const { location, slot } = await createLocation();
    const customer = await createCustomer();
    const hold = await acquireBookingHold(
      { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
      { now: NOW },
    );
    await updateAppointmentCustomerNotes(hold.appointmentId, "one");
    const snapshotAfterTwo = await listAppointmentEvents(hold.appointmentId);
    await updateAppointmentCustomerNotes(hold.appointmentId, "two");
    await cancelAppointment(hold.appointmentId);

    const events = await listAppointmentEvents(hold.appointmentId);
    assert.deepEqual(events.map((e) => e.type), ["CREATED", "NOTE_UPDATED", "NOTE_UPDATED", "CANCELLED"]);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].createdAt > events[i - 1].createdAt, "strictly increasing");
    }
    assert.deepEqual(events.slice(0, 2), snapshotAfterTwo); // earlier events untouched
  });
});

describe("failure atomicity", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("if the event insert fails, the status change rolls back", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });

    await withFailingWrites("AppointmentEvent", "INSERT", async () => {
      await assert.rejects(cancelAppointment(appointment.id), /forced test failure/);
      await assert.rejects(updateAppointmentCustomerNotes(appointment.id, "x"), /forced test failure/);
    });

    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }), appointment);
    assert.equal(await prisma.appointmentEvent.count(), 0);
  });

  it("if the appointment update fails, no event survives", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });

    await withFailingWrites("Appointment", "UPDATE", async () => {
      await assert.rejects(completeAppointment(appointment.id), /forced test failure/);
    });

    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status, "CONFIRMED");
    assert.equal(await prisma.appointmentEvent.count(), 0);
  });

  it("if the CREATED event fails, no hold is created", async () => {
    const { location, slot } = await createLocation();
    const customer = await createCustomer();
    await withFailingWrites("AppointmentEvent", "INSERT", async () => {
      await assert.rejects(
        acquireBookingHold(
          { customerId: customer.id, locationId: location.id, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
          { now: NOW },
        ),
        /forced test failure/,
      );
    });
    assert.equal(await prisma.appointment.count(), 0);
  });
});

describe("audit timestamp integrity", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  const dbNow = async () => (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;

  it("timestamps come from the database clock at the time of the change (never future-dated)", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });

    const before = await dbNow();
    await cancelAppointment(appointment.id);
    const after = await dbNow();

    const [event] = await listAppointmentEvents(appointment.id);
    // Millisecond column precision: compare at ms resolution.
    assert.ok(event.createdAt.getTime() >= Math.floor(before.getTime()), "not before the command started");
    assert.ok(event.createdAt.getTime() <= after.getTime(), "not after the command finished (no invented future time)");
  });

  it("concurrent edits are listed in their real execution order with strictly increasing times", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday, customerNotes: "v0" });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => updateAppointmentCustomerNotes(appointment.id, `v${i + 1}`)),
    );

    const events = await listAppointmentEvents(appointment.id);
    assert.equal(events.length, 10);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].createdAt > events[i - 1].createdAt, "strictly increasing");
      // Each change starts from the value the previous one left: listed order == execution order.
      const previous = events[i - 1].details as { after: string };
      const current = events[i].details as { before: string };
      assert.equal(current.before, previous.after);
    }
    const final = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    assert.equal(final.customerNotes, (events.at(-1)!.details as { after: string }).after);
  });

  it("refuses to write out-of-order history if the latest event is ahead of the database clock", async () => {
    const { slot } = await createLocation();
    const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
    // Simulates a future-dated row (e.g. a clock that was later stepped back).
    await prisma.appointmentEvent.create({
      data: {
        appointmentId: appointment.id,
        type: "NOTE_UPDATED",
        createdAt: new Date((await dbNow()).getTime() + 60 * 60 * 1000),
      },
    });

    await assert.rejects(cancelAppointment(appointment.id), /refusing to write out-of-order history/);

    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status, "CONFIRMED");
    assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id } }), 1);
  });
});
