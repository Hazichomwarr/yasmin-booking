import { Prisma, type AppointmentEventType } from "@prisma/client";

import type { AdminEventAttribution, RescheduledEventDetails } from "@/lib/booking/appointment-events";
import { lockAppointment, toAppointmentView, type AppointmentView } from "@/lib/booking/appointments";
import { applyLifecycleCommand } from "@/lib/booking/lifecycle";
import { LIFECYCLE_TRANSITIONS, type LifecycleCommand } from "@/lib/booking/lifecycle-policy";
import { rescheduleLocked, type RescheduleDestination } from "@/lib/booking/reschedule";
import { assertValidSalonTimeZone, parseSalonDate, salonClockTime, salonDateFromDatabase, salonToday } from "@/lib/booking/salon-calendar";
import { prisma } from "@/lib/prisma";

import { assertAdminAccess, type AdminAccess } from "./auth";

/**
 * Administrator appointment actions (YASMIN-2B.1): cancel, reschedule,
 * mark completed, mark no-show. There is deliberately no "confirm payment":
 * only verified Stripe evidence (payment fulfillment) confirms a booking.
 *
 * Each action is ONE READ COMMITTED transaction, in this order:
 *   1. Lock the appointment row — the global first lock, as for checkout,
 *      payment fulfillment and customer release, so they all serialize.
 *   2. Re-validate the admin session under that lock (revoked, expired,
 *      disabled or password-changed sessions cannot act mid-flight).
 *   3. Idempotency: an event with this operationId is a replay of the SAME
 *      request → return the recorded outcome, change nothing. A different
 *      request reusing the id → OPERATION_CONFLICT.
 *   4. Stale view: `expectedUpdatedAt` must equal the row's updatedAt, so an
 *      admin cannot act on a state someone else has since changed.
 *   5. The existing lifecycle policy decides the transition (terminal states
 *      are never left; repeating an applied action is a no-op with no event),
 *      plus administrator timing rules in the salon's own time zone.
 *   6. Change + exactly one event attributed to the session's AdminUser with
 *      the operationId and action-appropriate reason (columns, never
 *      `details`). Cancellation and rescheduling require a reason;
 *      completion and no-show may explicitly omit one.
 *
 * Never touched: Payment rows, Stripe, prices/deposit/balance snapshots,
 * hairstyle, stylist and notes. Cancellation releases capacity through the
 * capacity rule (CANCELLED never consumes), exactly once.
 */

export type AdminAppointmentAction =
  | { kind: "cancel" }
  | { kind: "complete" }
  | { kind: "markNoShow" }
  | { kind: "reschedule"; locationId: string; bookingSlotId: string; appointmentDate: string };

export type AdminAppointmentActionInput = {
  appointmentId: string;
  action: AdminAppointmentAction;
  /** Client-generated UUID, reused verbatim when retrying the same request. */
  operationId: string;
  /** The appointment's updatedAt (ISO) as the administrator last saw it. */
  expectedUpdatedAt: string;
  /** Required for cancel/reschedule; optional for complete/no-show. */
  reason?: string;
};

export type AdminActionWarning =
  /** Cancelled while a Stripe Checkout Session may still be paid; a later payment becomes a reconciliation case. */
  | "checkout-session-open"
  /** Cancelled while a Checkout Session's creation outcome is unknown. */
  | "checkout-outcome-uncertain"
  /** Cancelled with a received deposit; nothing was refunded. */
  | "deposit-received-not-refunded";

export type AdminActionResult = {
  outcome: "applied" | "already-applied" | "replayed";
  appointment: AppointmentView;
  eventId: string | null;
  warnings: AdminActionWarning[];
};

export type AdminActionErrorCode =
  | "INVALID_INPUT"
  | "SESSION_INVALID"
  | "STALE_APPOINTMENT"
  | "OPERATION_CONFLICT"
  | "APPOINTMENT_NOT_STARTED"
  | "DESTINATION_IN_PAST";

export class AdminActionError extends Error {
  constructor(readonly code: AdminActionErrorCode, message: string) {
    super(message);
    this.name = "AdminActionError";
  }
}

export const ADMIN_REASON_MIN = 1;
export const ADMIN_REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EVENT_FOR: Readonly<Record<AdminAppointmentAction["kind"], AppointmentEventType>> = {
  cancel: LIFECYCLE_TRANSITIONS.cancel.event,
  complete: LIFECYCLE_TRANSITIONS.complete.event,
  markNoShow: LIFECYCLE_TRANSITIONS.markNoShow.event,
  reschedule: "RESCHEDULED",
};

type Normalized = {
  appointmentId: string;
  action: AdminAppointmentAction;
  operationId: string;
  expectedUpdatedAt: Date;
  reason: string | null;
};

/** Validates untrusted input; throws INVALID_INPUT without touching the database. */
export function normalizeAdminActionInput(input: unknown): Normalized {
  const fail = (message: string): never => { throw new AdminActionError("INVALID_INPUT", message); };
  if (!input || typeof input !== "object") return fail("Expected an object.");
  const value = input as Record<string, unknown>;
  const appointmentId = typeof value.appointmentId === "string" && value.appointmentId.length > 0 && value.appointmentId.length <= 64 ? value.appointmentId : fail("appointmentId is required.");
  const operationId = typeof value.operationId === "string" && UUID.test(value.operationId.toLowerCase()) ? value.operationId.toLowerCase() : fail("operationId must be a UUID.");
  const expected = typeof value.expectedUpdatedAt === "string" ? new Date(value.expectedUpdatedAt) : new Date(Number.NaN);
  if (Number.isNaN(expected.getTime())) fail("expectedUpdatedAt must be an ISO timestamp.");

  const raw = value.action as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return fail("action is required.");
  let action: AdminAppointmentAction;
  switch (raw.kind) {
    case "cancel":
    case "complete":
    case "markNoShow":
      action = { kind: raw.kind };
      break;
    case "reschedule": {
      const { locationId, bookingSlotId, appointmentDate } = raw;
      if (typeof locationId !== "string" || typeof bookingSlotId !== "string" || typeof appointmentDate !== "string") return fail("reschedule needs locationId, bookingSlotId and appointmentDate.");
      try {
        parseSalonDate(appointmentDate);
      } catch {
        fail("appointmentDate must be YYYY-MM-DD.");
      }
      action = { kind: "reschedule", locationId, bookingSlotId, appointmentDate: appointmentDate.trim() };
      break;
    }
    default:
      return fail("Unknown action.");
  }

  let reason: string | null = null;
  const rawReason = value.reason;
  if (typeof rawReason === "string") {
    const normalizedReason = rawReason.trim();
    if (normalizedReason.length < ADMIN_REASON_MIN || normalizedReason.length > ADMIN_REASON_MAX) {
      fail(`reason must be ${ADMIN_REASON_MIN}–${ADMIN_REASON_MAX} characters.`);
    }
    reason = normalizedReason;
  } else if (rawReason !== undefined) {
    fail("reason must be text.");
  }
  if ((action.kind === "cancel" || action.kind === "reschedule") && reason === null) {
    fail("reason is required for cancellation and rescheduling.");
  }
  return { appointmentId, action, operationId, expectedUpdatedAt: expected, reason };
}

export async function performAdminAppointmentAction(access: AdminAccess, input: AdminAppointmentActionInput): Promise<AdminActionResult> {
  assertAdminAccess(access);
  const request = normalizeAdminActionInput(input);
  try {
    return await prisma.$transaction(
      (tx) => runAction(tx, access, request),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    // Two concurrent requests reusing one operationId on DIFFERENT appointments:
    // the unique index admits only one. (Same appointment: serialized by the row lock.)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AdminActionError("OPERATION_CONFLICT", "This operation id was already used for a different action.");
    }
    throw error;
  }
}

async function runAction(tx: Prisma.TransactionClient, access: AdminAccess, request: Normalized): Promise<AdminActionResult> {
  // 1. Serialize with every other operation on this appointment.
  const current = await lockAppointment(tx, request.appointmentId);
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;

  // 2. The session must still be valid now, not only when the request arrived.
  await assertSessionStillValid(tx, access, now);

  // 3. Replay of an already-applied request?
  const previous = await tx.appointmentEvent.findUnique({
    where: { operationId: request.operationId },
    select: { id: true, appointmentId: true, type: true, reason: true, actorAdminUserId: true, details: true },
  });
  if (previous) {
    if (!isSameRequest(previous, request)) throw new AdminActionError("OPERATION_CONFLICT", "This operation id was already used for a different action.");
    return { outcome: "replayed", appointment: toAppointmentView(current), eventId: previous.id, warnings: [] };
  }

  // 4. Optimistic concurrency against the state the administrator saw.
  if (current.updatedAt.getTime() !== request.expectedUpdatedAt.getTime()) {
    throw new AdminActionError("STALE_APPOINTMENT", "The appointment changed since it was loaded. Reload and try again.");
  }

  const attribution: AdminEventAttribution = { actorAdminUserId: access.adminUserId, operationId: request.operationId, reason: request.reason };
  const { action } = request;

  // 5–6. Policy and change.
  if (action.kind === "reschedule") {
    const change = await rescheduleLocked(tx, current, { appointmentId: current.id, ...action }, now, {
      attribution,
      assertDestination: (destination) => assertNotInPast(destination, now),
    });
    return { outcome: change.changed ? "applied" : "already-applied", appointment: change.appointment, eventId: change.eventId, warnings: [] };
  }

  const command: LifecycleCommand = action.kind;
  if ((command === "complete" || command === "markNoShow") && current.status === LIFECYCLE_TRANSITIONS[command].from[0]) {
    await assertAppointmentStarted(tx, current, now);
  }
  const change = await applyLifecycleCommand(tx, current, command, attribution);
  const warnings = command === "cancel" && change.changed ? await cancellationWarnings(tx, current.id) : [];
  return { outcome: change.changed ? "applied" : "already-applied", appointment: change.appointment, eventId: change.eventId, warnings };
}

async function assertSessionStillValid(tx: Prisma.TransactionClient, access: AdminAccess, now: Date): Promise<void> {
  const session = await tx.adminSession.findUnique({
    where: { id: access.sessionId },
    select: { adminUserId: true, createdAt: true, expiresAt: true, revokedAt: true, adminUser: { select: { disabledAt: true, passwordHash: true, passwordUpdatedAt: true } } },
  });
  const valid = session
    && session.adminUserId === access.adminUserId
    && session.revokedAt === null
    && now.getTime() < session.expiresAt.getTime()
    && session.adminUser.disabledAt === null
    && session.adminUser.passwordHash !== null
    && session.adminUser.passwordUpdatedAt !== null
    && session.adminUser.passwordUpdatedAt.getTime() <= session.createdAt.getTime();
  if (!valid) throw new AdminActionError("SESSION_INVALID", "Your admin session is no longer valid. Sign in again.");
}

function isSameRequest(
  event: { appointmentId: string; type: AppointmentEventType; reason: string | null; actorAdminUserId: string | null; details: Prisma.JsonValue },
  request: Normalized,
): boolean {
  if (event.appointmentId !== request.appointmentId || event.type !== EVENT_FOR[request.action.kind] || event.reason !== request.reason) return false;
  if (request.action.kind !== "reschedule") return true;
  const after = (event.details as unknown as RescheduledEventDetails | null)?.after;
  return after?.locationId === request.action.locationId && after.bookingSlotId === request.action.bookingSlotId && after.appointmentDate === request.action.appointmentDate;
}

/** Completion and no-show only once the visit's start time has been reached, in the salon's own zone. */
async function assertAppointmentStarted(tx: Prisma.TransactionClient, current: Awaited<ReturnType<typeof lockAppointment>>, now: Date): Promise<void> {
  const { timeZone } = await tx.salonLocation.findUniqueOrThrow({ where: { id: current.locationId }, select: { timeZone: true } });
  if (!hasStarted({ appointmentDate: salonDateFromDatabase(current.appointmentDate), slotTime: current.slotTimeSnapshot, timeZone }, now)) {
    throw new AdminActionError("APPOINTMENT_NOT_STARTED", "This appointment has not started yet in the salon's time.");
  }
}

/** A reschedule may not move a visit to a start time that has already passed (salon-local). */
function assertNotInPast(destination: RescheduleDestination, now: Date): void {
  if (hasStarted(destination, now)) {
    throw new AdminActionError("DESTINATION_IN_PAST", "That date and time have already passed at the salon.");
  }
}

/** True when the salon-local start (date + "HH:mm") is at or before now in `timeZone`. */
export function hasStarted(when: { appointmentDate: string; slotTime: string; timeZone: string }, now: Date): boolean {
  const zone = assertValidSalonTimeZone(when.timeZone, "Appointment location");
  const today = salonToday(zone, now);
  if (when.appointmentDate !== today) return when.appointmentDate < today;
  return `${when.slotTime}:00` <= salonClockTime(zone, now);
}

async function cancellationWarnings(tx: Prisma.TransactionClient, appointmentId: string): Promise<AdminActionWarning[]> {
  const payment = await tx.payment.findFirst({
    where: { appointmentId, purpose: "BOOKING_DEPOSIT" },
    select: { status: true, providerCheckoutSessionId: true, paidAt: true },
  });
  if (!payment) return [];
  if (payment.paidAt) return payment.status === "REFUNDED" ? [] : ["deposit-received-not-refunded"];
  if (payment.status === "PENDING") return [payment.providerCheckoutSessionId ? "checkout-session-open" : "checkout-outcome-uncertain"];
  return [];
}
