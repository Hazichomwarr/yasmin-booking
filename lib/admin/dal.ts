import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { resolveAdminSession, type AdminAccess } from "./auth";
import { ADMIN_COOKIE_NAME } from "./session-cookie";

/**
 * Admin data-access layer (YASMIN-2A), for Server Components. Every admin
 * page calls `requireAdmin()` itself — layouts are not relied on, because
 * they do not re-run on client navigation — and every admin data service
 * re-checks the returned grant. Memoized per request.
 */
export const getAdminAccess = cache(async (): Promise<AdminAccess | null> => {
  const values = (await cookies()).getAll(ADMIN_COOKIE_NAME);
  // Absent or ambiguous cookies are never guessed between.
  return values.length === 1 ? resolveAdminSession(values[0].value) : null;
});

export async function requireAdmin(): Promise<AdminAccess> {
  const access = await getAdminAccess();
  if (!access) redirect("/admin/login");
  return access;
}
