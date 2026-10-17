import { cookies } from "next/headers";

import { resolveAdminSession } from "@/lib/admin/auth";
import { getAdminRescheduleAvailability } from "@/lib/admin/reschedule-availability";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { isBookingError } from "@/lib/booking/errors";

export const runtime = "nodejs";

/** Authenticated, informational availability for one appointment's location. */
export async function GET(request: Request, ctx: { params: Promise<{ appointmentId: string }> }) {
  const values = (await cookies()).getAll(ADMIN_COOKIE_NAME);
  const access = values.length === 1 ? await resolveAdminSession(values[0].value) : null;
  if (!access) return Response.json({ error: { code: "SESSION_INVALID" } }, { status: 401 });

  const { appointmentId } = await ctx.params;
  const appointmentDate = new URL(request.url).searchParams.get("date");
  if (!appointmentDate) return Response.json({ error: { code: "INVALID_INPUT" } }, { status: 400 });

  try {
    const availability = await getAdminRescheduleAvailability(access, { appointmentId, appointmentDate });
    return availability
      ? Response.json({ availability }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: { code: "APPOINTMENT_NOT_FOUND" } }, { status: 404 });
  } catch (error) {
    if (isBookingError(error)) return Response.json({ error: { code: error.code } }, { status: 409 });
    return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
  }
}
