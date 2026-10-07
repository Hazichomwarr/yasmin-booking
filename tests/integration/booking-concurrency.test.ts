import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acquireBookingHold,
  capacityConsumingAppointments,
  isBookingError,
  type BookingHold,
} from "@/lib/booking";
import { prisma } from "@/lib/prisma";

import { assertBookingError } from "../support/assertions";
import { NOW, WEEK, createCustomer, createLocation, fillSlot } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

/** Real concurrent acquisitions against PostgreSQL — no mocks. */

type Outcome = { succeeded: BookingHold[]; capacityFull: number; other: unknown[] };

async function raceForSlot(
  slot: { id: string; locationId: string },
  appointmentDate: string,
  attempts: number,
): Promise<Outcome> {
  const customers = await Promise.all(Array.from({ length: attempts }, () => createCustomer()));
  const results = await Promise.allSettled(
    customers.map((customer) =>
      acquireBookingHold(
        { customerId: customer.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate },
        { now: NOW },
      ),
    ),
  );

  const outcome: Outcome = { succeeded: [], capacityFull: 0, other: [] };
  for (const result of results) {
    if (result.status === "fulfilled") outcome.succeeded.push(result.value);
    else if (isBookingError(result.reason, "CAPACITY_FULL")) outcome.capacityFull += 1;
    else outcome.other.push(result.reason);
  }
  return outcome;
}

function countConsuming(slotId: string, appointmentDate: string) {
  return prisma.appointment.count({
    where: {
      bookingSlotId: slotId,
      appointmentDate: new Date(`${appointmentDate}T00:00:00.000Z`),
      ...capacityConsumingAppointments(NOW),
    },
  });
}

describe("capacity under concurrency", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  const ROUNDS = 5;

  it(`20 simultaneous requests for capacity 10 → exactly 10 holds (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const { slot } = await createLocation({ name: `Round ${round}`, slots: [{ time: "11:00", capacity: 10 }] });

      const outcome = await raceForSlot(slot, WEEK.wednesday, 20);

      assert.deepEqual(outcome.other, [], `round ${round}: unexpected failures`);
      assert.equal(outcome.succeeded.length, 10, `round ${round}: successes`);
      assert.equal(outcome.capacityFull, 10, `round ${round}: CAPACITY_FULL`);
      assert.equal(await countConsuming(slot.id, WEEK.wednesday), 10, `round ${round}: consuming rows`);
      assert.equal(await prisma.appointment.count({ where: { bookingSlotId: slot.id } }), 10);
    }
  });

  it(`9 of 10 taken + 8 simultaneous requests → exactly 1 hold (${ROUNDS} rounds)`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const { slot } = await createLocation({ name: `Final ${round}`, slots: [{ time: "11:00", capacity: 10 }] });
      await fillSlot(slot, WEEK.thursday, 9);

      const outcome = await raceForSlot(slot, WEEK.thursday, 8);

      assert.deepEqual(outcome.other, [], `round ${round}: unexpected failures`);
      assert.equal(outcome.succeeded.length, 1, `round ${round}: successes`);
      assert.equal(outcome.capacityFull, 7, `round ${round}: CAPACITY_FULL`);
      assert.equal(await countConsuming(slot.id, WEEK.thursday), 10, `round ${round}: consuming rows`);
    }
  });

  it("same recurring slot on different dates keeps independent capacity", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 10 }] });

    const [monday, tuesday] = await Promise.all([
      raceForSlot(slot, WEEK.monday, 15),
      raceForSlot(slot, WEEK.tuesday, 15),
    ]);

    assert.deepEqual([...monday.other, ...tuesday.other], []);
    assert.equal(monday.succeeded.length, 10);
    assert.equal(tuesday.succeeded.length, 10);
    assert.equal(await countConsuming(slot.id, WEEK.monday), 10);
    assert.equal(await countConsuming(slot.id, WEEK.tuesday), 10);
  });
});

describe("failed acquisition leaves no partial state", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("CAPACITY_FULL creates nothing and changes nothing", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 2 }] });
    await fillSlot(slot, WEEK.monday, 2);
    const customer = await createCustomer();

    const appointmentsBefore = await prisma.appointment.findMany({ orderBy: { id: "asc" } });
    const customerBefore = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });

    await assertBookingError(
      acquireBookingHold(
        { customerId: customer.id, locationId: slot.locationId, bookingSlotId: slot.id, appointmentDate: WEEK.monday },
        { now: NOW },
      ),
      "CAPACITY_FULL",
    );

    assert.deepEqual(await prisma.appointment.findMany({ orderBy: { id: "asc" } }), appointmentsBefore);
    assert.equal(await prisma.payment.count(), 0);
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }), customerBefore);
  });

  it("an unexpected failure after the slot lock rolls back, propagates unchanged, and releases the lock", async () => {
    const { slot } = await createLocation({ slots: [{ time: "11:00", capacity: 10 }] });
    const customer = await createCustomer();
    const request = {
      customerId: customer.id,
      locationId: slot.locationId,
      bookingSlotId: slot.id,
      appointmentDate: WEEK.monday,
    };

    // PostgreSQL rejects NUL bytes in text, so the INSERT fails after the
    // lock and capacity count have already run inside the transaction.
    await assert.rejects(
      acquireBookingHold({ ...request, customerNotes: "bad\u0000note" }, { now: NOW }),
      (error: unknown) => !isBookingError(error),
    );
    assert.equal(await prisma.appointment.count(), 0);

    // The lock was released with the rollback: the next acquisition proceeds.
    const hold = await acquireBookingHold(request, { now: NOW });
    assert.equal(hold.status, "PENDING_PAYMENT");
  });
});
