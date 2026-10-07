import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acquireBookingHold,
  cancelAppointment,
  completeAppointment,
  isBookingError,
  listAppointmentEvents,
  markAppointmentNoShow,
  rescheduleAppointment,
  type RescheduledEventDetails,
} from "@/lib/booking";
import { prisma } from "@/lib/prisma";

import {
  NOW,
  WEEK,
  consumedIn,
  createAppointmentIn,
  createCustomer,
  createLocation,
  fillSlot,
} from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

/** Real concurrent lifecycle commands against PostgreSQL — no mocks. */

const ROUNDS = 8;

const settle = <T>(promises: Promise<T>[]) => Promise.allSettled(promises);
const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled");
const rejected = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

const reschedule = (appointmentId: string, slot: { id: string; locationId: string }, appointmentDate: string) =>
  rescheduleAppointment(
    { appointmentId, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate },
    { now: NOW },
  );

describe("concurrent terminal transitions", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  for (const [label, a, b] of [
    ["COMPLETE vs CANCEL", completeAppointment, cancelAppointment],
    ["COMPLETE vs NO_SHOW", completeAppointment, markAppointmentNoShow],
    ["CANCEL vs NO_SHOW", cancelAppointment, markAppointmentNoShow],
  ] as const) {
    it(`${label}: exactly one wins, exactly one terminal event (${ROUNDS} rounds)`, async () => {
      const { slot } = await createLocation();
      for (let round = 1; round <= ROUNDS; round++) {
        const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });

        const results = await settle([a(appointment.id), b(appointment.id)]);

        const wins = fulfilled(results);
        const losses = rejected(results);
        assert.equal(wins.length, 1, `round ${round}`);
        assert.equal(losses.length, 1, `round ${round}`);
        assert.ok(isBookingError(losses[0].reason, "INVALID_APPOINTMENT_TRANSITION"), String(losses[0].reason));

        const final = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
        const events = await listAppointmentEvents(appointment.id);
        assert.equal(final.status, wins[0].value.appointment.status);
        assert.deepEqual(events.map((e) => e.type), [final.status]); // event matches state
      }
    });
  }

  it(`CANCEL vs CANCEL: both succeed, one changes, one event (${ROUNDS} rounds)`, async () => {
    const { slot } = await createLocation();
    for (let round = 1; round <= ROUNDS; round++) {
      const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
      const results = await settle([cancelAppointment(appointment.id), cancelAppointment(appointment.id)]);
      const values = fulfilled(results).map((r) => r.value.changed).sort();
      assert.deepEqual(values, [false, true], `round ${round}`);
      assert.deepEqual((await listAppointmentEvents(appointment.id)).map((e) => e.type), ["CANCELLED"]);
    }
  });
});

describe("concurrent rescheduling", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it(`two appointments race for the final destination place: exactly one moves (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const { slots } = await createLocation({
        name: `Final ${round}`,
        slots: [
          { time: "11:00", capacity: 10 },
          { time: "14:00", capacity: 3 },
        ],
      });
      const [source, destination] = slots;
      await fillSlot(destination, WEEK.tuesday, 2); // one place left
      const first = await createAppointmentIn({ slot: source, appointmentDate: WEEK.monday });
      const second = await createAppointmentIn({ slot: source, appointmentDate: WEEK.monday });

      const results = await settle([
        reschedule(first.id, destination, WEEK.tuesday),
        reschedule(second.id, destination, WEEK.tuesday),
      ]);

      assert.equal(fulfilled(results).length, 1, `round ${round}`);
      const [loss] = rejected(results);
      assert.ok(isBookingError(loss.reason, "CAPACITY_FULL"), String(loss.reason));
      assert.equal(await consumedIn(destination.id, WEEK.tuesday), 3); // never 4
      assert.equal(await consumedIn(source.id, WEEK.monday), 1); // the loser stayed put

      const loserId = fulfilled(results)[0].value.appointment.id === first.id ? second.id : first.id;
      const loser = await prisma.appointment.findUniqueOrThrow({ where: { id: loserId } });
      assert.equal(loser.bookingSlotId, source.id);
      assert.deepEqual(await listAppointmentEvents(loserId), []);
    }
  });

  it(`a reschedule and a new hold race for the final place: exactly one gets it (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const { location, slots } = await createLocation({
        name: `Mixed ${round}`,
        slots: [
          { time: "11:00", capacity: 10 },
          { time: "14:00", capacity: 2 },
        ],
      });
      const [source, destination] = slots;
      await fillSlot(destination, WEEK.tuesday, 1);
      const moving = await createAppointmentIn({ slot: source, appointmentDate: WEEK.monday });
      const customer = await createCustomer();

      const results = await settle<unknown>([
        reschedule(moving.id, destination, WEEK.tuesday),
        acquireBookingHold(
          { customerId: customer.id, locationId: location.id, bookingSlotId: destination.id, appointmentDate: WEEK.tuesday },
          { now: NOW },
        ),
      ]);

      assert.equal(fulfilled(results).length, 1, `round ${round}`);
      assert.ok(isBookingError(rejected(results)[0].reason, "CAPACITY_FULL"));
      assert.equal(await consumedIn(destination.id, WEEK.tuesday), 2);
    }
  });

  it(`reschedule vs cancel of the same appointment stays consistent (${ROUNDS} rounds)`, async () => {
    const { slots } = await createLocation({
      slots: [
        { time: "11:00", capacity: 10 },
        { time: "14:00", capacity: 10 },
      ],
    });
    const [source, destination] = slots;
    const outcomes = { cancelFirst: 0, rescheduleFirst: 0 };

    for (let round = 1; round <= ROUNDS; round++) {
      const appointment = await createAppointmentIn({ slot: source, appointmentDate: WEEK.monday });
      const date = [WEEK.tuesday, WEEK.wednesday, WEEK.thursday, WEEK.friday][round % 4];

      const [moved, cancelled] = await settle<unknown>([
        reschedule(appointment.id, destination, date),
        cancelAppointment(appointment.id),
      ]);

      // Cancel always succeeds (CONFIRMED either way when it runs).
      assert.equal(cancelled.status, "fulfilled");
      const final = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      const events = await listAppointmentEvents(appointment.id);
      assert.equal(final.status, "CANCELLED");

      if (moved.status === "fulfilled") {
        outcomes.rescheduleFirst += 1;
        assert.deepEqual(events.map((e) => e.type), ["RESCHEDULED", "CANCELLED"]);
        const details = events[0].details as RescheduledEventDetails;
        assert.equal(final.bookingSlotId, details.after.bookingSlotId);
        assert.equal(final.appointmentDate.toISOString().slice(0, 10), details.after.appointmentDate);
      } else {
        outcomes.cancelFirst += 1;
        assert.ok(isBookingError(moved.reason, "APPOINTMENT_NOT_RESCHEDULABLE"), String(moved.reason));
        assert.deepEqual(events.map((e) => e.type), ["CANCELLED"]);
        assert.equal(final.bookingSlotId, source.id);
      }
      // A cancelled appointment never holds destination capacity.
      assert.equal(await consumedIn(destination.id, date), 0);
    }
    console.log(`    reschedule-vs-cancel outcomes: ${JSON.stringify(outcomes)}`);
  });

  it(`two reschedules of the same appointment serialize into a consistent chain (${ROUNDS} rounds)`, async () => {
    const { slots } = await createLocation({
      slots: [
        { time: "05:00", capacity: 10 },
        { time: "11:00", capacity: 10 },
        { time: "14:00", capacity: 10 },
      ],
    });
    const [source, y, z] = slots;

    for (let round = 1; round <= ROUNDS; round++) {
      const appointment = await createAppointmentIn({ slot: source, appointmentDate: WEEK.monday });

      const results = await settle([reschedule(appointment.id, y, WEEK.tuesday), reschedule(appointment.id, z, WEEK.wednesday)]);
      assert.equal(fulfilled(results).length, 2, `round ${round}: both are serially valid`);

      const events = await listAppointmentEvents(appointment.id);
      assert.deepEqual(events.map((e) => e.type), ["RESCHEDULED", "RESCHEDULED"]);
      const [first, second] = events.map((e) => e.details as RescheduledEventDetails);
      assert.equal(first.before.bookingSlotId, source.id);
      assert.deepEqual(second.before, first.after); // the second move starts where the first ended

      const final = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.equal(final.bookingSlotId, second.after.bookingSlotId);
      assert.equal(final.slotTimeSnapshot, second.after.slotTime);
      const total =
        (await consumedIn(source.id, WEEK.monday)) +
        (await consumedIn(y.id, WEEK.tuesday)) +
        (await consumedIn(z.id, WEEK.wednesday));
      assert.equal(total, 1, "the appointment owns exactly one place");
      await prisma.appointment.update({ where: { id: appointment.id }, data: { status: "CANCELLED" } }); // free for next round
    }
  });

  it(`opposite-direction moves X→Y and Y→X in bulk: no deadlock, no overbooking (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const { location, slots } = await createLocation({
        name: `Swap ${round}`,
        slots: [
          { time: "11:00", capacity: 6 },
          { time: "14:00", capacity: 6 },
        ],
      });
      const [x, y] = slots;
      const inX = await Promise.all(Array.from({ length: 5 }, () => createAppointmentIn({ slot: x, appointmentDate: WEEK.monday })));
      const inY = await Promise.all(Array.from({ length: 5 }, () => createAppointmentIn({ slot: y, appointmentDate: WEEK.monday })));
      const customers = await Promise.all(Array.from({ length: 4 }, () => createCustomer()));

      const results = await settle<unknown>([
        ...inX.map((a) => reschedule(a.id, y, WEEK.monday)),
        ...inY.map((a) => reschedule(a.id, x, WEEK.monday)),
        // New holds competing for the single spare place in each slot.
        ...customers.map((c, i) =>
          acquireBookingHold(
            { customerId: c.id, locationId: location.id, bookingSlotId: (i % 2 ? x : y).id, appointmentDate: WEEK.monday },
            { now: NOW },
          ),
        ),
      ]);

      const unexpected = rejected(results).filter((r) => !isBookingError(r.reason, "CAPACITY_FULL"));
      assert.deepEqual(unexpected.map((r) => String(r.reason)), [], `round ${round}: no deadlocks or other errors`);
      assert.ok((await consumedIn(x.id, WEEK.monday)) <= 6, "X never overbooked");
      assert.ok((await consumedIn(y.id, WEEK.monday)) <= 6, "Y never overbooked");
      // Each of the 10 existing appointments owns exactly one place (moved or
      // not), plus one place per hold that succeeded.
      const successfulHolds = results.slice(10).filter((r) => r.status === "fulfilled").length;
      assert.equal(
        (await consumedIn(x.id, WEEK.monday)) + (await consumedIn(y.id, WEEK.monday)),
        10 + successfulHolds,
      );
    }
  });
});
