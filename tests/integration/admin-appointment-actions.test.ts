import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { AdminActionError, performAdminAppointmentAction, type AdminAppointmentAction } from "@/lib/admin/appointment-actions";
import { resolveAdminSession, revokeAdminSession, signInAdmin, type AdminAccess } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import { isBookingError } from "@/lib/booking/errors";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { addSalonDays, salonClockTime, salonToday, salonWeekday, type SalonDate } from "@/lib/booking/salon-calendar";
import { prisma } from "@/lib/prisma";

import { consumedIn, createAppointmentIn, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import { createHeld, createPlace, databaseNow, holdRowLock, paid, waitForLockWaiters } from "../support/payment-fixtures";

const TZ = "America/New_York";
const REASON = "Customer called the salon";
let adminCount = 0;

async function admin(): Promise<{ access: AdminAccess; token: string }> {
  adminCount += 1;
  const email = `admin${adminCount}@example.test`;
  await provisionAdminPassword({ email, password: "Velvet-Comb-2026!" }, { hashParams: { N: 2 ** 14, r: 8, p: 1 } });
  const result = await signInAdmin(email, "Velvet-Comb-2026!");
  const token = (result as { token: string }).token;
  const access = await resolveAdminSession(token);
  assert.ok(access);
  return { access, token };
}

const versionOf = async (appointmentId: string) => (await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).updatedAt.toISOString();

async function act(access: AdminAccess, appointmentId: string, action: AdminAppointmentAction, options: { operationId?: string; expectedUpdatedAt?: string; reason?: string; omitReason?: boolean } = {}) {
  return performAdminAppointmentAction(access, {
    appointmentId,
    action,
    operationId: options.operationId ?? randomUUID(),
    expectedUpdatedAt: options.expectedUpdatedAt ?? await versionOf(appointmentId),
    ...(options.omitReason ? {} : { reason: options.reason ?? REASON }),
  });
}

const code = (expected: string) => (error: unknown) => (error instanceof AdminActionError || isBookingError(error)) && (error as { code: string }).code === expected;

async function salonNow() {
  const now = await databaseNow();
  return { now, today: salonToday(TZ, now) };
}

function nextWeekday(from: SalonDate, minDays = 1): SalonDate {
  let date = addSalonDays(from, minDays);
  while (salonWeekday(date) === 0 || salonWeekday(date) === 6) date = addSalonDays(date, 1);
  return date;
}

async function confirmedPlace(options: { capacity?: number } = {}) {
  const { location, slots } = await createLocation({ name: "William Street", slots: [{ time: "05:00", capacity: options.capacity ?? 10 }, { time: "11:00", capacity: options.capacity ?? 10 }, { time: "14:00", capacity: options.capacity ?? 10 }] });
  return { location, slots };
}

const eventsOf = (appointmentId: string) => prisma.appointmentEvent.findMany({ where: { appointmentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("admin cancellation", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("cancels, keeps every record and snapshot, attributes the event, and releases capacity once", async () => {
    const { access } = await admin();
    const slot = await createPlace({ capacity: 1 });
    const held = await createHeld(slot, { date: "2027-03-08" });
    assert.equal((await applyVerifiedCheckoutSession(paid(held))).kind, "confirmed");
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointmentId }, include: { payments: true, customer: true } });
    const now = await databaseNow();
    assert.equal(await consumedIn(slot.id, "2027-03-08", now), 1);

    const operationId = randomUUID();
    const result = await act(access, held.appointmentId, { kind: "cancel" }, { operationId, reason: "  Customer moved away  " });
    assert.deepEqual([result.outcome, result.appointment.status, result.warnings], ["applied", "CANCELLED", ["deposit-received-not-refunded"]]);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointmentId }, include: { payments: true, customer: true } });
    assert.equal(after.id, before.id);
    assert.deepEqual(after.payments, before.payments, "payments untouched (no refund, no void)");
    assert.deepEqual(after.customer, before.customer);
    for (const field of ["totalPriceCents", "depositAmountCents", "balanceDueCents", "locationNameSnapshot", "slotTimeSnapshot", "hairstyleNameSnapshot", "appointmentDate", "bookingSlotId"] as const) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal(await consumedIn(slot.id, "2027-03-08", await databaseNow()), 0, "place released");

    const cancelled = (await eventsOf(held.appointmentId)).filter((event) => event.type === "CANCELLED");
    assert.equal(cancelled.length, 1);
    assert.deepEqual([cancelled[0].actorAdminUserId, cancelled[0].operationId, cancelled[0].reason], [access.adminUserId, operationId, "Customer moved away"]);
    assert.deepEqual(cancelled[0].details, { schemaVersion: 1, fromStatus: "CONFIRMED", toStatus: "CANCELLED" });
  });

  it("repeated requests: the same operation replays, a new one is a no-op; one event, capacity released once", async () => {
    const { access } = await admin();
    const { slots } = await confirmedPlace();
    const booked = await createAppointmentIn({ slot: slots[1], appointmentDate: "2027-03-09" });
    const operationId = randomUUID();
    const version = await versionOf(booked.id);
    const first = await act(access, booked.id, { kind: "cancel" }, { operationId, expectedUpdatedAt: version });
    // Retry after an uncertain network response: same id, the OLD version → replay, not "stale".
    const retry = await act(access, booked.id, { kind: "cancel" }, { operationId, expectedUpdatedAt: version });
    const again = await act(access, booked.id, { kind: "cancel" });
    assert.deepEqual([first.outcome, retry.outcome, again.outcome], ["applied", "replayed", "already-applied"]);
    assert.equal(retry.eventId, first.eventId);
    assert.equal((await eventsOf(booked.id)).filter((event) => event.type === "CANCELLED").length, 1);
  });

  it("an open Checkout Session is allowed but flagged; a later payment becomes a reconciliation case, never a revival", async () => {
    const { access } = await admin();
    const slot = await createPlace();
    const held = await createHeld(slot, { date: "2027-03-10" });
    const result = await act(access, held.appointmentId, { kind: "cancel" });
    assert.deepEqual(result.warnings, ["checkout-session-open"]);
    const late = await applyVerifiedCheckoutSession(paid(held));
    assert.equal(late.kind, "reconciled");
    const [appointment, payment] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: held.appointmentId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: held.paymentId } }),
    ]);
    assert.deepEqual([appointment.status, payment.status, payment.allocatedAt, payment.reconciliationReason], ["CANCELLED", "PAID", null, "APPOINTMENT_NOT_PAYABLE"]);
  });

  it("flags a cancellation whose Checkout creation outcome is unknown", async () => {
    const { access } = await admin();
    const held = await createHeld(await createPlace(), { date: "2027-03-10", bindSession: false });
    assert.deepEqual((await act(access, held.appointmentId, { kind: "cancel" })).warnings, ["checkout-outcome-uncertain"]);
  });

  it("racing a verified payment webhook: never confirmed after cancel, money never lost (6 rounds)", async () => {
    const { access } = await admin();
    for (let round = 0; round < 6; round += 1) {
      const held = await createHeld(await createPlace(), { date: "2027-03-11" });
      const version = await versionOf(held.appointmentId);
      const unlock = await holdRowLock("Appointment", held.appointmentId);
      const racing = Promise.allSettled([
        act(access, held.appointmentId, { kind: "cancel" }, { expectedUpdatedAt: version }),
        applyVerifiedCheckoutSession(paid(held)),
      ]);
      await waitForLockWaiters(2);
      await unlock();
      const [cancel, fulfil] = await racing;
      assert.equal(fulfil.status, "fulfilled");
      const [appointment, payment] = await Promise.all([
        prisma.appointment.findUniqueOrThrow({ where: { id: held.appointmentId } }),
        prisma.payment.findUniqueOrThrow({ where: { id: held.paymentId } }),
      ]);
      assert.equal(payment.status, "PAID", "the received money is always recorded");
      if (cancel.status === "fulfilled") {
        assert.equal(appointment.status, "CANCELLED");
        // Cancel first → reconciliation case; fulfillment first would have changed updatedAt → stale.
        assert.deepEqual([payment.allocatedAt, payment.reconciliationReason], [null, "APPOINTMENT_NOT_PAYABLE"]);
      } else {
        assert.ok(code("STALE_APPOINTMENT")(cancel.reason), String(cancel.reason));
        assert.equal(appointment.status, "CONFIRMED");
        assert.ok(payment.allocatedAt);
      }
      assert.ok((await eventsOf(held.appointmentId)).filter((event) => event.type === "CANCELLED").length <= 1);
    }
  });
});

describe("admin completion and no-show", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("only after the visit's salon-local start, from CONFIRMED, preserving payment and history", async () => {
    const { access } = await admin();
    const { slots } = await confirmedPlace();
    const { today } = await salonNow();
    const future = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today) });
    await assert.rejects(act(access, future.id, { kind: "complete" }), code("APPOINTMENT_NOT_STARTED"));
    await assert.rejects(act(access, future.id, { kind: "markNoShow" }), code("APPOINTMENT_NOT_STARTED"));

    const past = await createAppointmentIn({ slot: slots[1], appointmentDate: addSalonDays(today, -1) });
    const done = await act(access, past.id, { kind: "complete" }, { omitReason: true });
    assert.deepEqual([done.outcome, done.appointment.status], ["applied", "COMPLETED"]);
    const [event] = await eventsOf(past.id);
    assert.deepEqual([event.type, event.actorAdminUserId, event.reason], ["COMPLETED", access.adminUserId, null]);
    assert.ok(event.operationId, "completion retains its idempotency key when reason is omitted");

    const absent = await createAppointmentIn({ slot: slots[2], appointmentDate: addSalonDays(today, -2) });
    assert.equal((await act(access, absent.id, { kind: "markNoShow" }, { omitReason: true })).appointment.status, "NO_SHOW");
    const [noShow] = await eventsOf(absent.id);
    assert.deepEqual([noShow.type, noShow.actorAdminUserId, noShow.reason], ["NO_SHOW", access.adminUserId, null]);
    assert.ok(noShow.operationId, "no-show retains its idempotency key when reason is omitted");
  });

  it("rejects conflicting terminal transitions and non-confirmed sources", async () => {
    const { access } = await admin();
    const { slots } = await confirmedPlace();
    const { today } = await salonNow();
    const past = await createAppointmentIn({ slot: slots[0], appointmentDate: addSalonDays(today, -1) });
    await act(access, past.id, { kind: "complete" });
    await assert.rejects(act(access, past.id, { kind: "markNoShow" }), code("INVALID_APPOINTMENT_TRANSITION"));
    await assert.rejects(act(access, past.id, { kind: "cancel" }), code("INVALID_APPOINTMENT_TRANSITION"));
    const pending = await createAppointmentIn({ slot: slots[1], appointmentDate: addSalonDays(today, -1), status: "PENDING_PAYMENT" });
    await assert.rejects(act(access, pending.id, { kind: "complete" }), code("INVALID_APPOINTMENT_TRANSITION"));
    assert.equal((await eventsOf(past.id)).length, 1);
  });

  it("completion racing no-show from two administrators: exactly one terminal outcome (5 rounds)", async () => {
    const [a, b] = [await admin(), await admin()];
    const { slots } = await confirmedPlace();
    const { today } = await salonNow();
    for (let round = 0; round < 5; round += 1) {
      const booked = await createAppointmentIn({ slot: slots[round % 3], appointmentDate: addSalonDays(today, -1) });
      const version = await versionOf(booked.id);
      const results = await Promise.allSettled([
        act(a.access, booked.id, { kind: "complete" }, { expectedUpdatedAt: version }),
        act(b.access, booked.id, { kind: "markNoShow" }, { expectedUpdatedAt: version }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      for (const r of results) if (r.status === "rejected") assert.ok(code("STALE_APPOINTMENT")(r.reason), String(r.reason));
      const events = await eventsOf(booked.id);
      assert.equal(events.length, 1);
      assert.ok(["COMPLETED", "NO_SHOW"].includes((await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status));
    }
  });
});

describe("admin reschedule", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("moves atomically, keeps id, money and payment, records before/after, and moves capacity", async () => {
    const { access } = await admin();
    const { location, slots } = await confirmedPlace();
    const { today } = await salonNow();
    const from = nextWeekday(today, 2);
    const to = nextWeekday(today, 45); // beyond the public 30-day horizon: allowed for administrators
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: from });
    await prisma.payment.create({ data: { appointmentId: booked.id, provider: "STRIPE", purpose: "BOOKING_DEPOSIT", amountCents: 4000, status: "PAID", providerCheckoutSessionId: "cs_test_resched", providerPaymentIntentId: "pi_test_resched", paidAt: new Date(), allocatedAt: new Date() } });
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id }, include: { payments: true } });
    const now = await databaseNow();

    const operationId = randomUUID();
    const result = await act(access, booked.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[2].id, appointmentDate: to }, { operationId });
    assert.deepEqual([result.outcome, result.appointment.id, result.appointment.appointmentDate, result.appointment.slotTimeSnapshot], ["applied", booked.id, to, "14:00"]);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id }, include: { payments: true } });
    assert.deepEqual(after.payments, before.payments, "no new or changed Payment: no second deposit");
    assert.equal(await prisma.payment.count(), 1);
    for (const field of ["totalPriceCents", "depositAmountCents", "balanceDueCents", "status", "customerId", "hairstyleNameSnapshot"] as const) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual([await consumedIn(slots[0].id, from, now), await consumedIn(slots[2].id, to, now)], [0, 1]);

    const [event] = await eventsOf(booked.id);
    assert.deepEqual([event.type, event.actorAdminUserId, event.operationId, event.reason], ["RESCHEDULED", access.adminUserId, operationId, REASON]);
    const details = event.details as { before: { appointmentDate: string; slotTime: string; locationName: string }; after: { appointmentDate: string; slotTime: string } };
    assert.deepEqual([details.before.appointmentDate, details.before.slotTime, details.before.locationName, details.after.appointmentDate, details.after.slotTime], [from, "05:00", "William Street", to, "14:00"]);
  });

  it("enforces eligibility, weekdays, active slots and the salon's present, but not the public cutoff or horizon", async () => {
    const { access } = await admin();
    const { location, slots } = await confirmedPlace();
    const inactive = await prisma.bookingSlot.create({ data: { locationId: location.id, localStartTime: new Date("1970-01-01T16:00:00.000Z"), capacity: 10, isActive: false } });
    const { now, today } = await salonNow();
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 3) });
    const move = (bookingSlotId: string, appointmentDate: string) => act(access, booked.id, { kind: "reschedule", locationId: location.id, bookingSlotId, appointmentDate });

    let saturday = today;
    while (salonWeekday(saturday) !== 6) saturday = addSalonDays(saturday, 1);
    await assert.rejects(move(slots[1].id, saturday), code("ONLINE_BOOKING_CLOSED_FOR_DAY"));
    await assert.rejects(move(inactive.id, nextWeekday(today, 4)), code("SLOT_NOT_BOOKABLE"));
    await assert.rejects(move(slots[1].id, addSalonDays(today, -1)), code("INVALID_APPOINTMENT_DATE"));

    // Today: a slot already started is refused; one starting in ~20 minutes is allowed (no 60-minute cutoff).
    if (salonWeekday(today) >= 1 && salonWeekday(today) <= 5) {
      const [h, m] = salonClockTime(TZ, now).split(":").map(Number);
      const soon = h * 60 + m + 20;
      if (h * 60 + m >= 1 && soon < 24 * 60) {
        const minuteSlot = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        const started = await prisma.bookingSlot.create({ data: { locationId: location.id, localStartTime: new Date(`1970-01-01T${minuteSlot(h * 60 + m - 1)}:00.000Z`), capacity: 10 } });
        const upcoming = await prisma.bookingSlot.create({ data: { locationId: location.id, localStartTime: new Date(`1970-01-01T${minuteSlot(soon)}:00.000Z`), capacity: 10 } });
        await assert.rejects(move(started.id, today), code("DESTINATION_IN_PAST"));
        assert.equal((await move(upcoming.id, today)).outcome, "applied");
      }
    }
    const terminal = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 3), status: "CANCELLED" });
    await assert.rejects(act(access, terminal.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[1].id, appointmentDate: nextWeekday(today, 5) }), code("APPOINTMENT_NOT_RESCHEDULABLE"));
    const pending = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 3), status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 600_000) });
    await assert.rejects(act(access, pending.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[1].id, appointmentDate: nextWeekday(today, 5) }), code("APPOINTMENT_NOT_RESCHEDULABLE"));
  });

  it("two administrators moving different bookings into the last place: exactly one succeeds", async () => {
    const [a, b] = [await admin(), await admin()];
    const { location, slots } = await confirmedPlace({ capacity: 1 });
    const { today } = await salonNow();
    const target = nextWeekday(today, 6);
    const first = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 2) });
    const second = await createAppointmentIn({ slot: slots[1], appointmentDate: nextWeekday(today, 2) });
    const results = await Promise.allSettled([
      act(a.access, first.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[2].id, appointmentDate: target }),
      act(b.access, second.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[2].id, appointmentDate: target }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("CAPACITY_FULL")(loser.reason));
    assert.equal(await consumedIn(slots[2].id, target, await databaseNow()), 1);
  });

  it("repeated reschedules: same operation replays; same destination again is a no-op", async () => {
    const { access } = await admin();
    const { location, slots } = await confirmedPlace();
    const { today } = await salonNow();
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 2) });
    const action = { kind: "reschedule" as const, locationId: location.id, bookingSlotId: slots[1].id, appointmentDate: nextWeekday(today, 8) };
    const operationId = randomUUID();
    const version = await versionOf(booked.id);
    const first = await act(access, booked.id, action, { operationId, expectedUpdatedAt: version });
    const retry = await act(access, booked.id, action, { operationId, expectedUpdatedAt: version });
    const again = await act(access, booked.id, action);
    assert.deepEqual([first.outcome, retry.outcome, again.outcome], ["applied", "replayed", "already-applied"]);
    assert.equal((await eventsOf(booked.id)).length, 1);
    // Reusing the id for a DIFFERENT destination is a conflict, not a replay.
    const differentDestinationDate = nextWeekday(action.appointmentDate, 1);
    await assert.rejects(act(access, booked.id, { ...action, appointmentDate: differentDestinationDate }, { operationId }), code("OPERATION_CONFLICT"));
  });
});

describe("admin action safety", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("refuses a stale view without changing anything", async () => {
    const [a, b] = [await admin(), await admin()];
    const { location, slots } = await confirmedPlace();
    const { today } = await salonNow();
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: nextWeekday(today, 2) });
    const seenByA = await versionOf(booked.id);
    await act(b.access, booked.id, { kind: "reschedule", locationId: location.id, bookingSlotId: slots[1].id, appointmentDate: nextWeekday(today, 3) });
    await assert.rejects(act(a.access, booked.id, { kind: "cancel" }, { expectedUpdatedAt: seenByA }), code("STALE_APPOINTMENT"));
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status, "CONFIRMED");
    assert.equal((await eventsOf(booked.id)).length, 1);
  });

  it("an operation id cannot be reused for another appointment, even concurrently", async () => {
    const { access } = await admin();
    const { slots } = await confirmedPlace();
    const one = await createAppointmentIn({ slot: slots[0], appointmentDate: "2027-03-08" });
    const two = await createAppointmentIn({ slot: slots[1], appointmentDate: "2027-03-08" });
    const operationId = randomUUID();
    const results = await Promise.allSettled([act(access, one.id, { kind: "cancel" }, { operationId }), act(access, two.id, { kind: "cancel" }, { operationId })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(code("OPERATION_CONFLICT")((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason));
    assert.equal(await prisma.appointment.count({ where: { status: "CANCELLED" } }), 1);
  });

  it("requires a live session at the moment of the change", async () => {
    const { access, token } = await admin();
    const { slots } = await confirmedPlace();
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: "2027-03-08" });
    await revokeAdminSession(token);
    await assert.rejects(act(access, booked.id, { kind: "cancel" }), code("SESSION_INVALID"));
    const forged = Object.freeze({ ...access });
    await assert.rejects(act(forged, booked.id, { kind: "cancel" }), /Admin authorization required/);
    const other = await admin();
    await prisma.adminUser.update({ where: { id: other.access.adminUserId }, data: { disabledAt: new Date() } });
    await assert.rejects(act(other.access, booked.id, { kind: "cancel" }), code("SESSION_INVALID"));
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status, "CONFIRMED");
    assert.equal(await prisma.appointmentEvent.count(), 0);
  });

  it("stores attribution in columns only, with no credentials anywhere in history", async () => {
    const { access, token } = await admin();
    const { slots } = await confirmedPlace();
    const booked = await createAppointmentIn({ slot: slots[0], appointmentDate: "2027-03-08" });
    await act(access, booked.id, { kind: "cancel" });
    const text = JSON.stringify(await prisma.appointmentEvent.findMany());
    const adminRow = await prisma.adminUser.findUniqueOrThrow({ where: { id: access.adminUserId } });
    for (const secret of [token, adminRow.passwordHash!, access.sessionId, "Velvet-Comb"]) assert.equal(text.includes(secret), false);
    // The database refuses partial attribution and requires reasons for the
    // two administrative actions whose policy mandates one.
    await assert.rejects(prisma.appointmentEvent.create({ data: { appointmentId: booked.id, type: "NOTE_UPDATED", actorAdminUserId: access.adminUserId } }), /AppointmentEvent_admin_attribution_complete/);
    await assert.rejects(prisma.appointmentEvent.create({ data: { appointmentId: booked.id, type: "NOTE_UPDATED", operationId: randomUUID() } }), /AppointmentEvent_admin_attribution_complete/);
    await assert.rejects(prisma.appointmentEvent.create({ data: { appointmentId: booked.id, type: "CANCELLED", actorAdminUserId: access.adminUserId, operationId: randomUUID() } }), /AppointmentEvent_required_action_reason/);
  });
});
