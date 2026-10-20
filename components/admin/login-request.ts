export type AdminLoginRequestResult =
  | { ok: true }
  | { ok: false; message: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Keeps the request boundary independent of the form's loading state, so the
 * UI can always release a submission after either a response or a failure.
 */
export async function requestAdminLogin(
  input: { email: string; password: string },
  fetcher: FetchLike = fetch,
): Promise<AdminLoginRequestResult> {
  try {
    const response = await fetcher("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.ok) return { ok: true };

    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return { ok: false, message: body?.error?.message ?? "Sign-in failed. Please try again." };
  } catch {
    return { ok: false, message: "We could not reach the server. Check your connection and try again." };
  }
}
