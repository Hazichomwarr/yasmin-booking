import { AdminActionError, performAdminAppointmentAction, type AdminActionErrorCode, type AdminAppointmentActionInput, type AdminActionResult } from "@/lib/admin/appointment-actions";
import { resolveAdminSession, type AdminAccess } from "@/lib/admin/auth";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";
import { isBookingError } from "@/lib/booking/errors";
import type { BookingErrorCode } from "@/lib/booking/errors";

import { loadAdminConfig } from "./admin-auth-api";
import type { Env } from "./config";
import { publicJson } from "./public-responses";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

/**
 * POST /api/admin/appointments/{appointmentId}/actions (YASMIN-2B.1).
 *
 * Body: { action: {kind, …}, operationId, expectedUpdatedAt, reason? }.
 * `reason` is required for cancellation/rescheduling and optional for
 * explicit completion/no-show actions.
 * Guards, before any domain work: admin configuration → exact Origin /
 * Fetch-Metadata → JSON → body limit → admin session (cookie only) →
 * allow-listed fields. The actor is ALWAYS the session's AdminUser; any
 * other field (e.g. an actor id) is rejected. The service re-validates the
 * session under the appointment lock and enforces every rule.
 *
 * Responses carry only the outcome, the resulting public-safe appointment
 * facts and warnings. Logs carry codes only.
 */

export const MAX_ADMIN_ACTION_BODY_BYTES = 4 * 1024;
const ALLOWED_FIELDS = new Set(["action", "operationId", "expectedUpdatedAt", "reason"]);

export type AdminActionsApiDeps = {
  env: () => Env;
  resolveSession: (token: unknown) => Promise<AdminAccess | null>;
  perform: (access: AdminAccess, input: AdminAppointmentActionInput) => Promise<AdminActionResult>;
  log: (entry: { status: number; code: string }) => void;
};

export const defaultAdminActionsApiDeps: AdminActionsApiDeps = {
  env: () => process.env,
  resolveSession: resolveAdminSession,
  perform: performAdminAppointmentAction,
  log: (entry) => console.info(JSON.stringify({ event: "admin-appointment-action", ...entry })),
};

const ADMIN_ERRORS: Readonly<Record<AdminActionErrorCode, [number, string]>> = {
  INVALID_INPUT: [400, "The request is not valid."],
  SESSION_INVALID: [401, "Your admin session is no longer valid. Sign in again."],
  STALE_APPOINTMENT: [409, "This appointment changed since you loaded it. Reload and try again."],
  OPERATION_CONFLICT: [409, "This action id was already used for a different action."],
  APPOINTMENT_NOT_STARTED: [409, "This appointment has not started yet."],
  DESTINATION_IN_PAST: [409, "That date and time have already passed."],
};

/** Domain refusals an administrator can act on; anything else is a 500. */
const BOOKING_ERRORS: Partial<Readonly<Record<BookingErrorCode, [number, string]>>> = {
  APPOINTMENT_NOT_FOUND: [404, "Appointment not found."],
  INVALID_APPOINTMENT_TRANSITION: [409, "That change is not allowed from the appointment's current status."],
  APPOINTMENT_NOT_RESCHEDULABLE: [409, "Only confirmed appointments can be rescheduled."],
  CAPACITY_FULL: [409, "That time is full."],
  SLOT_NOT_FOUND: [409, "That time is not offered at this location."],
  SLOT_NOT_BOOKABLE: [409, "That time is not currently offered."],
  LOCATION_NOT_FOUND: [409, "That location does not exist."],
  LOCATION_NOT_BOOKABLE: [409, "That location is not taking bookings."],
  INVALID_APPOINTMENT_DATE: [409, "That date is not available."],
  ONLINE_BOOKING_CLOSED_FOR_DAY: [409, "The salon does not take bookings on that day."],
};

export function createAdminActionsApi(deps: AdminActionsApiDeps = defaultAdminActionsApiDeps) {
  function error(status: number, code: string, message: string): Response {
    deps.log({ status, code });
    return publicJson(status, { error: { code, message } });
  }

  return async function POST(request: Request, appointmentId: string): Promise<Response> {
    const cfg = loadAdminConfig(deps.env());
    if (!cfg) return error(503, "SERVICE_UNAVAILABLE", "Admin actions are temporarily unavailable.");
    if (checkMutationOrigin(request.headers, new Set([cfg.appOrigin]))) return error(403, "REQUEST_ORIGIN_REJECTED", "This request was not accepted.");
    if (!isJsonContentType(request.headers.get("content-type"))) return error(415, "UNSUPPORTED_CONTENT_TYPE", "Send the request as application/json.");
    const body = await readBodyText(request, MAX_ADMIN_ACTION_BODY_BYTES);
    if (!body.ok) return body.problem === "TOO_LARGE" ? error(413, "REQUEST_TOO_LARGE", "The request is too large.") : error(400, "INVALID_INPUT", "The request is not valid.");

    const access = await deps.resolveSession(readAdminSessionCookie(request.headers));
    if (!access) return error(401, "SESSION_INVALID", ADMIN_ERRORS.SESSION_INVALID[1]);

    const json = parseJsonObject(body.text);
    if (!json.ok || Object.keys(json.value).some((key) => !ALLOWED_FIELDS.has(key))) return error(400, "INVALID_INPUT", ADMIN_ERRORS.INVALID_INPUT[1]);

    try {
      const result = await deps.perform(access, { ...(json.value as Omit<AdminAppointmentActionInput, "appointmentId">), appointmentId });
      deps.log({ status: 200, code: result.outcome });
      const { appointment } = result;
      return publicJson(200, {
        outcome: result.outcome,
        warnings: result.warnings,
        appointment: { id: appointment.id, status: appointment.status, appointmentDate: appointment.appointmentDate, slotTime: appointment.slotTimeSnapshot, locationName: appointment.locationNameSnapshot, updatedAt: appointment.updatedAt.toISOString() },
      });
    } catch (caught) {
      if (caught instanceof AdminActionError) return error(ADMIN_ERRORS[caught.code][0], caught.code, ADMIN_ERRORS[caught.code][1]);
      if (isBookingError(caught) && BOOKING_ERRORS[caught.code]) {
        const [status, message] = BOOKING_ERRORS[caught.code]!;
        return error(status, caught.code, message);
      }
      return error(500, "INTERNAL_ERROR", "Something went wrong.");
    }
  };
}

export const adminActionsApi = createAdminActionsApi();
