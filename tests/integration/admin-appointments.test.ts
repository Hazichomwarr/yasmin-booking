import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import { ADMIN_PAGE_SIZE, ADMIN_TIME_ZONE, getAdminAppointmentDetail, getAdminDashboard, listAdminAppointments, parseAdminAppointmentFilters } from "@/lib/admin/appointments";
import { resolveAdminSession, signInAdmin, type AdminAccess } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import { addSalonDays, salonToday, type SalonDate } from "@/lib/booking/salon-calendar";
import { prisma } from "@/lib/prisma";

import { createAppointmentIn, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import { databaseNow } from "../support/payment-fixtures";

const MINUTE = 60_000;

async function adminAccess(): Promise<AdminAccess> {
  await provisionAdminPassword({ email: "owner@example.test", password: "Velvet-Comb-2026!" }, { hashParams: { N: 2 ** 14, r: 8, p: 1 } });
  const result = await signInAdmin("owner@example.test", "Velvet-Comb-2026!");
  const access = await resolveAdminSession((result as { token: string }).token);
  assert.ok(access);
  return access;
}

async function place() {
  const { location, slots } = await createLocation({ name: "William Street", slots: [{ time: "05:00" }, { time: "11:00" }, { time: "14:00" }] });
  await prisma.salonLocation.update({ where: { id: location.id }, data: { addressLine1: "524 William St", city: "East Orange", state: "NJ" } });
  return slots;
}

async function appointment(slot: Awaited<ReturnType<typeof place>>[number], date: SalonDate, status: AppointmentStatus, options: { name?: string; holdMinutes?: number | null; hairstyle?: { id: string; name: string } | null; stylist?: string } = {}) {
  const now = await databaseNow();
  const row = await createAppointmentIn({
    slot, appointmentDate: date, status,
    holdExpiresAt: options.holdMinutes === undefined || options.holdMinutes === null ? null : new Date(now.getTime() + options.holdMinutes * MINUTE),
    hairstyle: options.hairstyle ?? null, preferredStylistName: options.stylist ?? null,
  });
  if (options.name) await prisma.customer.update({ where: { id: row.customerId }, data: { name: options.name } });
  return row;
}

async function deposit(appointmentId: string, kind: "open" | "uncertain" | "paid" | "unallocated" | "expired") {
  const now = await databaseNow();
  const paidAt = new Date(now.getTime() - MINUTE);
  const base = { appointmentId, provider: "STRIPE" as const, purpose: "BOOKING_DEPOSIT" as const, amountCents: 4000, currency: "usd" };
  const session = `cs_test_admin_${appointmentId}`;
  const intent = `pi_test_admin_${appointmentId}`;
  const data = {
    open: { ...base, providerCheckoutSessionId: session },
    uncertain: { ...base },
    paid: { ...base, status: "PAID" as const, providerCheckoutSessionId: session, providerPaymentIntentId: intent, paidAt, allocatedAt: paidAt },
    unallocated: { ...base, status: "PAID" as const, providerCheckoutSessionId: session, providerPaymentIntentId: intent, paidAt, reconciliationReason: "APPOINTMENT_NOT_PAYABLE" as const },
    expired: { ...base, status: "EXPIRED" as const, providerCheckoutSessionId: session },
  }[kind];
  return prisma.payment.create({ data });
}

describe("admin appointment reads", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("refuses every read without a genuine admin grant", async () => {
    const fake = Object.freeze({ adminUserId: "x", email: "x@example.test", sessionId: "x", expiresAt: new Date() });
    await assert.rejects(getAdminDashboard(fake), /Admin authorization required/);
    await assert.rejects(listAdminAppointments(fake, parseAdminAppointmentFilters({})), /Admin authorization required/);
    await assert.rejects(getAdminAppointmentDetail(fake, "anything"), /Admin authorization required/);
    await assert.rejects(getAdminDashboard(null as unknown as AdminAccess), /Admin authorization required/);
  });

  it("shows an empty state", async () => {
    const access = await adminAccess();
    const dashboard = await getAdminDashboard(access);
    assert.deepEqual(dashboard.countsByStatus, { PENDING_PAYMENT: 0, CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0, NO_SHOW: 0 });
    assert.equal(dashboard.todayAppointments.count + dashboard.upcoming.count + dashboard.pending.count + dashboard.cancelled.count, 0);
    assert.deepEqual([(await listAdminAppointments(access, parseAdminAppointmentFilters({}))).total], [0]);
  });

  it("builds dashboard sections from existing statuses and the capacity rule", async () => {
    const access = await adminAccess();
    const [s0500, s1100, s1400] = await place();
    const today = salonToday(ADMIN_TIME_ZONE, await databaseNow());
    const tomorrow = addSalonDays(today, 1);
    const later = addSalonDays(today, 3);
    const todayConfirmed = await appointment(s1400, today, "CONFIRMED", { name: "Today Confirmed" });
    await appointment(s1100, tomorrow, "CONFIRMED", { name: "Tomorrow Confirmed" });
    await appointment(s0500, later, "PENDING_PAYMENT", { name: "Active Hold", holdMinutes: 10 });
    await appointment(s1100, later, "PENDING_PAYMENT", { name: "Lapsed Hold", holdMinutes: -10 });
    await appointment(s1400, addSalonDays(today, 5), "CANCELLED", { name: "Cancelled One" });
    await appointment(s1100, addSalonDays(today, -1), "COMPLETED", { name: "Yesterday Done" });

    const dashboard = await getAdminDashboard(access);
    assert.equal(dashboard.today, today);
    assert.deepEqual(dashboard.countsByStatus, { PENDING_PAYMENT: 2, CONFIRMED: 2, COMPLETED: 1, CANCELLED: 1, NO_SHOW: 0 });
    assert.deepEqual(dashboard.todayAppointments.appointments.map((a) => a.id), [todayConfirmed.id]);
    // Upcoming = after today AND occupying a place: the lapsed hold and the cancellation do not.
    assert.deepEqual(dashboard.upcoming.appointments.map((a) => a.customerName), ["Tomorrow Confirmed", "Active Hold"]);
    assert.equal(dashboard.upcoming.count, 2);
    assert.deepEqual(dashboard.confirmedUpcoming.appointments.map((a) => a.customerName), ["Today Confirmed", "Tomorrow Confirmed"]);
    assert.equal(dashboard.pending.count, 2);
    assert.deepEqual(dashboard.cancelled.appointments.map((a) => a.customerName), ["Cancelled One"]);
  });

  it("limits dashboard previews to three and retains the capacity-aware upcoming URL filter", async () => {
    const access = await adminAccess();
    const [slot] = await place();
    const today = salonToday(ADMIN_TIME_ZONE, await databaseNow());

    for (let offset = 1; offset <= 4; offset += 1) {
      await appointment(slot, addSalonDays(today, offset), "CONFIRMED", { name: `Upcoming ${offset}` });
    }

    const dashboard = await getAdminDashboard(access);
    assert.equal(dashboard.upcoming.count, 4);
    assert.equal(dashboard.upcoming.appointments.length, 3);
    assert.deepEqual(dashboard.upcoming.appointments.map((item) => item.customerName), ["Upcoming 1", "Upcoming 2", "Upcoming 3"]);

    const filters = parseAdminAppointmentFilters({ range: "upcoming" });
    assert.equal(filters.range, "upcoming");
    assert.equal((await listAdminAppointments(access, filters)).total, 4);
  });

  it("interprets deposits from stored facts, never from an initiated Checkout", async () => {
    const access = await adminAccess();
    const [slot] = await place();
    const date = addSalonDays(salonToday(ADMIN_TIME_ZONE, await databaseNow()), 2);
    const cases = {
      none: await appointment(slot, date, "PENDING_PAYMENT", { name: "No Payment", holdMinutes: 10 }),
      open: await appointment(slot, date, "PENDING_PAYMENT", { name: "Checkout Open", holdMinutes: 30 }),
      uncertain: await appointment(slot, date, "PENDING_PAYMENT", { name: "Checkout Uncertain", holdMinutes: 30 }),
      paid: await appointment(slot, date, "CONFIRMED", { name: "Paid Deposit" }),
      unallocated: await appointment(slot, date, "CANCELLED", { name: "Paid But Cancelled" }),
      expired: await appointment(slot, date, "PENDING_PAYMENT", { name: "Checkout Expired", holdMinutes: -5 }),
    };
    for (const kind of ["open", "uncertain", "paid", "unallocated", "expired"] as const) await deposit(cases[kind].id, kind);

    const { appointments } = await listAdminAppointments(access, parseAdminAppointmentFilters({ date }));
    const byName = Object.fromEntries(appointments.map((a) => [a.customerName, a.payment]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(byName).map(([name, p]) => [name, [p.depositState, p.depositPaid, p.remainingCents, p.needsAttention]])),
      {
        "No Payment": ["not-started", false, 20_000, false],
        "Checkout Open": ["checkout-started", false, 20_000, false],
        "Checkout Uncertain": ["checkout-uncertain", false, 20_000, true],
        "Paid Deposit": ["paid", true, 16_000, false],
        "Paid But Cancelled": ["received-unallocated", false, 20_000, true],
        "Checkout Expired": ["checkout-ended", false, 20_000, false],
      },
    );
  });

  it("flags an unresolved payment exception naming the booking", async () => {
    const access = await adminAccess();
    const [slot] = await place();
    const date = addSalonDays(salonToday(ADMIN_TIME_ZONE, await databaseNow()), 2);
    const booked = await appointment(slot, date, "PENDING_PAYMENT", { holdMinutes: 10 });
    const now = await databaseNow();
    await prisma.paymentProcessingException.create({ data: { provider: "STRIPE", checkoutSessionId: "cs_test_orphan", paymentIntentId: "pi_test_orphan", verifiedAmountCents: 4000, verifiedCurrency: "usd", expectedAppointmentId: booked.id, category: "MISSING_ASSOCIATION", problem: "PAYMENT_NOT_FOUND", moneyReceived: true, firstObservedAt: now, lastObservedAt: now } });
    const [row] = (await listAdminAppointments(access, parseAdminAppointmentFilters({}))).appointments;
    assert.deepEqual([row.payment.needsAttention, row.payment.bookingState], [true, "needs-attention"]);
  });

  it("filters by date, status and case-insensitive name, and paginates", async () => {
    const access = await adminAccess();
    const [slot, other] = await place();
    const today = salonToday(ADMIN_TIME_ZONE, await databaseNow());
    const day = addSalonDays(today, 4);
    for (let i = 0; i < ADMIN_PAGE_SIZE + 5; i += 1) await appointment(i % 2 ? slot : other, day, "CONFIRMED", { name: `Client ${String(i).padStart(2, "0")}` });
    await appointment(slot, addSalonDays(today, 6), "CANCELLED", { name: "Amina Diallo" });
    await appointment(other, addSalonDays(today, 7), "CONFIRMED", { name: "Fatou AMINATA" });

    const page1 = await listAdminAppointments(access, parseAdminAppointmentFilters({ date: day }));
    const page2 = await listAdminAppointments(access, parseAdminAppointmentFilters({ date: day, page: "2" }));
    assert.deepEqual([page1.total, page1.pageCount, page1.appointments.length, page2.appointments.length], [25, 2, 20, 5]);
    assert.equal(new Set([...page1.appointments, ...page2.appointments].map((a) => a.id)).size, 25);
    assert.equal((await listAdminAppointments(access, parseAdminAppointmentFilters({ date: day, page: "9" }))).appointments.length, 0);

    assert.deepEqual((await listAdminAppointments(access, parseAdminAppointmentFilters({ q: "amina" }))).appointments.map((a) => a.customerName), ["Fatou AMINATA", "Amina Diallo"]);
    assert.deepEqual((await listAdminAppointments(access, parseAdminAppointmentFilters({ q: "amina", status: "CANCELLED" }))).appointments.map((a) => a.customerName), ["Amina Diallo"]);
    assert.equal((await listAdminAppointments(access, parseAdminAppointmentFilters({ status: "NO_SHOW" }))).total, 0);
  });

  it("shows the full detail without payment-provider identifiers or credentials", async () => {
    const access = await adminAccess();
    const [slot] = await place();
    const date = addSalonDays(salonToday(ADMIN_TIME_ZONE, await databaseNow()), 2);
    const category = await prisma.hairstyleCategory.create({ data: { name: "Braids", slug: "braids" } });
    const style = await prisma.hairstyle.create({ data: { name: "Knotless Braids", slug: "knotless", categoryId: category.id } });
    const booked = await appointment(slot, date, "CONFIRMED", { name: "Detail Customer", hairstyle: style, stylist: "Amina" });
    await prisma.appointment.update({ where: { id: booked.id }, data: { accessTokenHash: "a".repeat(64), accessTokenIssuedAt: new Date(Date.now() - MINUTE), accessTokenExpiresAt: new Date(Date.now() + MINUTE) } });
    await deposit(booked.id, "paid");
    await prisma.appointmentEvent.create({ data: { appointmentId: booked.id, type: "PAYMENT_CONFIRMED", details: { paymentId: "secret-payment-id", stripeEventId: "evt_test_secret" } } });

    const detail = await getAdminAppointmentDetail(access, booked.id);
    assert.ok(detail);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: booked.customerId } });
    assert.deepEqual(detail.customer, { name: "Detail Customer", email: customer.email, phone: customer.phone });
    assert.deepEqual(detail.location, { name: "William Street", address: "524 William St, East Orange, NJ", timeZone: "America/New_York" });
    assert.deepEqual([detail.appointmentDate, detail.slotTime, detail.hairstyleName, detail.preferredStylistName], [date, "05:00", "Knotless Braids", "Amina"]);
    assert.deepEqual([detail.totalPriceCents, detail.payment.depositLabel, detail.payment.remainingCents, detail.status], [20_000, "Deposit paid", 16_000, "CONFIRMED"]);
    assert.deepEqual(detail.history.map((event) => event.type), ["PAYMENT_CONFIRMED"]);
    const text = JSON.stringify(detail);
    for (const secret of ["cs_test_admin", "pi_test_admin", "a".repeat(64), "secret-payment-id", "evt_test_secret", booked.customerId]) assert.equal(text.includes(secret), false, secret);
    assert.equal(await getAdminAppointmentDetail(access, "does-not-exist"), null);
  });
});
