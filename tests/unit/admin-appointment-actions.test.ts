import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import { AdminActionError, hasStarted, normalizeAdminActionInput, type AdminAppointmentActionInput } from "@/lib/admin/appointment-actions";
import type { AdminAccess } from "@/lib/admin/auth";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { BookingError } from "@/lib/booking/errors";
import { assertReschedulable, decideTransition, type LifecycleCommand } from "@/lib/booking/lifecycle-policy";
import { createAdminActionsApi } from "@/lib/http/admin-appointment-actions-api";

const OP = "8f14e45f-ceea-467a-9575-6b0b2f1c2a11";
const base = { appointmentId: "appt_1", operationId: OP, expectedUpdatedAt: "2027-03-01T15:00:00.000Z", reason: "Customer called to cancel" };

describe("appointment lifecycle transition matrix (existing policy, reused)", () => {
  const statuses: AppointmentStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"];
  const outcome = (command: LifecycleCommand, status: AppointmentStatus) => {
    try {
      const decision = decideTransition(command, status);
      return decision.kind === "apply" ? decision.to : "no-op";
    } catch (error) {
      return (error as BookingError).code === "INVALID_APPOINTMENT_TRANSITION" ? "rejected" : "unexpected";
    }
  };
  it("is exactly the documented matrix", () => {
    const matrix = Object.fromEntries(statuses.map((status) => [status, (["cancel", "complete", "markNoShow"] as const).map((command) => outcome(command, status))]));
    assert.deepEqual(matrix, {
      //                cancel       complete     markNoShow
      PENDING_PAYMENT: ["CANCELLED", "rejected", "rejected"],
      CONFIRMED: ["CANCELLED", "COMPLETED", "NO_SHOW"],
      COMPLETED: ["rejected", "no-op", "rejected"],
      CANCELLED: ["no-op", "rejected", "rejected"],
      NO_SHOW: ["rejected", "rejected", "no-op"],
    });
  });
  it("reschedules only CONFIRMED appointments", () => {
    for (const status of statuses) {
      if (status === "CONFIRMED") assert.doesNotThrow(() => assertReschedulable(status));
      else assert.throws(() => assertReschedulable(status), (e: unknown) => (e as BookingError).code === "APPOINTMENT_NOT_RESCHEDULABLE");
    }
  });
});

describe("admin action input", () => {
  it("normalizes valid input for every action", () => {
    for (const action of [{ kind: "cancel" }, { kind: "complete" }, { kind: "markNoShow" }, { kind: "reschedule", locationId: "loc", bookingSlotId: "slot", appointmentDate: "2027-03-08" }]) {
      const normalized = normalizeAdminActionInput({ ...base, action, operationId: OP.toUpperCase(), reason: "  Customer called to cancel  " });
      assert.deepEqual([normalized.action.kind, normalized.operationId, normalized.reason], [action.kind, OP, "Customer called to cancel"]);
    }
  });
  it("requires reasons for cancellation and rescheduling, but permits omission for completion and no-show", () => {
    for (const action of [{ kind: "cancel" }, { kind: "reschedule", locationId: "loc", bookingSlotId: "slot", appointmentDate: "2027-03-08" }]) {
      assert.throws(
        () => normalizeAdminActionInput({ ...base, action, reason: undefined }),
        (e: unknown) => e instanceof AdminActionError && e.code === "INVALID_INPUT",
      );
    }
    for (const action of [{ kind: "complete" }, { kind: "markNoShow" }] as const) {
      const normalized = normalizeAdminActionInput({ ...base, action, reason: undefined });
      assert.equal(normalized.reason, null);
    }
    const stated = normalizeAdminActionInput({ ...base, action: { kind: "complete" }, reason: "  x  " });
    assert.equal(stated.reason, "x");
  });
  it("rejects malformed input before any database work", () => {
    const bad: unknown[] = [
      null,
      { ...base, action: { kind: "confirmPayment" } },
      { ...base, action: { kind: "cancel" }, operationId: "not-a-uuid" },
      { ...base, action: { kind: "cancel" }, reason: "   " },
      { ...base, action: { kind: "cancel" }, reason: "x".repeat(501) },
      { ...base, action: { kind: "complete" }, reason: 42 },
      { ...base, action: { kind: "cancel" }, expectedUpdatedAt: "yesterday-ish" },
      { ...base, action: { kind: "reschedule", locationId: "loc", bookingSlotId: "slot", appointmentDate: "2027-02-30" } },
      { ...base, action: { kind: "reschedule", bookingSlotId: "slot", appointmentDate: "2027-03-08" } },
      { ...base, appointmentId: "", action: { kind: "cancel" } },
    ];
    for (const input of bad) assert.throws(() => normalizeAdminActionInput(input), (e: unknown) => e instanceof AdminActionError && e.code === "INVALID_INPUT", JSON.stringify(input));
  });
});

describe("salon-local start time", () => {
  // 2027-03-01T15:00:00Z = 10:00 in New York (EST).
  const now = new Date("2027-03-01T15:00:00.000Z");
  const at = (appointmentDate: string, slotTime: string, timeZone = "America/New_York") => hasStarted({ appointmentDate, slotTime, timeZone }, now);
  it("compares the salon's own date and wall clock", () => {
    assert.equal(at("2027-02-28", "14:00"), true);
    assert.equal(at("2027-03-01", "09:59"), true);
    assert.equal(at("2027-03-01", "10:00"), true, "a visit starting exactly now has started");
    assert.equal(at("2027-03-01", "10:01"), false);
    assert.equal(at("2027-03-02", "05:00"), false);
    // Same instant is already Tuesday 00:00 in Tokyo.
    assert.equal(at("2027-03-01", "23:00", "Asia/Tokyo"), true);
  });
  it("follows DST: 2027-03-14 08:30Z is 04:30 EDT", () => {
    const spring = new Date("2027-03-14T08:30:00.000Z");
    assert.equal(hasStarted({ appointmentDate: "2027-03-14", slotTime: "04:30", timeZone: "America/New_York" }, spring), true);
    assert.equal(hasStarted({ appointmentDate: "2027-03-14", slotTime: "05:00", timeZone: "America/New_York" }, spring), false);
  });
});

describe("admin action HTTP boundary", () => {
  const ORIGIN = "https://book.example.test";
  const access = Object.freeze({ adminUserId: "admin_1", email: "owner@example.test", sessionId: "session_1", expiresAt: new Date() }) as AdminAccess;
  function api(options: { session?: AdminAccess | null; perform?: (a: AdminAccess, i: AdminAppointmentActionInput) => Promise<never> | ReturnType<typeof okResult> } = {}) {
    const calls: Array<{ access: AdminAccess; input: AdminAppointmentActionInput }> = [];
    const post = createAdminActionsApi({
      env: () => ({ APP_BASE_URL: ORIGIN, RATE_LIMIT_SECRET: "s".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none", NODE_ENV: "test" }),
      resolveSession: async () => (options.session === undefined ? access : options.session),
      perform: async (a, input) => { calls.push({ access: a, input }); return (options.perform ?? okResult)(a, input); },
      log: () => {},
    });
    const send = (body: unknown, headers: Record<string, string> = {}) =>
      post(new Request(`${ORIGIN}/api/admin/appointments/appt_9/actions`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `${ADMIN_COOKIE_NAME}=${"t".repeat(43)}`, ...headers }, body: JSON.stringify(body) }), "appt_9");
    return { send, calls };
  }
  function okResult() {
    return Promise.resolve({ outcome: "applied" as const, eventId: "evt", warnings: [], appointment: { id: "appt_9", status: "CANCELLED", appointmentDate: "2027-03-08", slotTimeSnapshot: "11:00", locationNameSnapshot: "William Street", updatedAt: new Date("2027-03-01T15:00:00Z") } as never });
  }
  const body = { action: { kind: "cancel" }, operationId: OP, expectedUpdatedAt: base.expectedUpdatedAt, reason: "Customer called" };

  it("acts as the session's administrator on the path's appointment", async () => {
    const h = api();
    const response = await h.send(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: "applied", warnings: [], appointment: { id: "appt_9", status: "CANCELLED", appointmentDate: "2027-03-08", slotTime: "11:00", locationName: "William Street", updatedAt: "2027-03-01T15:00:00.000Z" } });
    assert.equal(h.calls[0].access, access);
    assert.equal(h.calls[0].input.appointmentId, "appt_9");
  });
  it("never trusts a client-supplied actor or appointment id", async () => {
    const h = api();
    assert.equal((await h.send({ ...body, actorAdminUserId: "someone_else" })).status, 400);
    assert.equal((await h.send({ ...body, appointmentId: "other_appt" })).status, 400);
    assert.equal(h.calls.length, 0);
  });
  it("rejects foreign origins, non-JSON and missing sessions before acting", async () => {
    const h = api({ session: null });
    assert.equal((await h.send(body)).status, 401);
    const g = api();
    assert.equal((await g.send(body, { origin: "https://evil.example" })).status, 403);
    assert.equal((await g.send(body, { "content-type": "text/plain" })).status, 415);
    assert.equal(g.calls.length, 0);
  });
  it("maps domain refusals to fixed messages", async () => {
    const stale = api({ perform: async () => { throw new AdminActionError("STALE_APPOINTMENT", "internal detail"); } });
    const response = await stale.send(body);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "STALE_APPOINTMENT");
    const full = api({ perform: async () => { throw new BookingError("CAPACITY_FULL", "internal detail"); } });
    assert.equal((await (await full.send(body)).json()).error.message, "That time is full.");
    const unknown = api({ perform: async () => { throw new Error("db password leaked?"); } });
    const crashed = await unknown.send(body);
    assert.equal(crashed.status, 500);
    assert.equal((await crashed.text()).includes("password"), false);
  });
});
