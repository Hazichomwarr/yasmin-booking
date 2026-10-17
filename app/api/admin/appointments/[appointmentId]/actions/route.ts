import { adminActionsApi } from "@/lib/http/admin-appointment-actions-api";

export const runtime = "nodejs";

/** Administrator appointment action: cancel, reschedule, complete, or mark no-show. */
export async function POST(request: Request, ctx: RouteContext<"/api/admin/appointments/[appointmentId]/actions">) {
  const { appointmentId } = await ctx.params;
  return adminActionsApi(request, appointmentId);
}
