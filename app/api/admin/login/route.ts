import { adminAuthApi } from "@/lib/http/admin-auth-api";

export const runtime = "nodejs";

/** Admin sign-in: { email, password } → __Host-yasmin_admin session cookie. */
export const POST = adminAuthApi.login;
