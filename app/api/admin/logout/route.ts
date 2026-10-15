import { adminAuthApi } from "@/lib/http/admin-auth-api";

export const runtime = "nodejs";

/** Admin sign-out: revokes the session in the cookie and clears it. */
export const POST = adminAuthApi.logout;
