/**
 * Guards for cookie-authenticated (or cookie-issuing) mutations. Every check
 * runs before any domain service is invoked.
 *
 * CSRF: SameSite=Lax is defence in depth only. The primary control is an
 * exact Origin match against the configured application origin(s) — never
 * one derived from Host or forwarded headers. Fetch Metadata, when sent,
 * must say same-origin. A JSON content type is required, so a cross-site
 * HTML form can never reach the handler and a cross-origin fetch needs a
 * CORS preflight, which this API never grants.
 */

export type OriginRejection = "ORIGIN_MISSING" | "ORIGIN_NULL" | "ORIGIN_MALFORMED" | "ORIGIN_NOT_ALLOWED" | "FETCH_SITE_NOT_SAME_ORIGIN";

export function checkMutationOrigin(headers: Headers, allowedOrigins: ReadonlySet<string>): OriginRejection | null {
  const origin = headers.get("origin");
  if (origin === null || origin.trim() === "") return "ORIGIN_MISSING";
  if (origin === "null") return "ORIGIN_NULL";
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "ORIGIN_MALFORMED";
  }
  // A serialized origin has no path, credentials, query or trailing slash.
  if (parsed.origin !== origin) return "ORIGIN_MALFORMED";
  if (!allowedOrigins.has(origin)) return "ORIGIN_NOT_ALLOWED";

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return "FETCH_SITE_NOT_SAME_ORIGIN";
  return null;
}

/** application/json, optionally with charset=utf-8 (any case, optionally quoted); nothing else. */
export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const [type, ...params] = value.split(";").map((part) => part.trim());
  if (type.toLowerCase() !== "application/json") return false;
  return params.every((param) => {
    const match = /^charset=("?)utf-8\1$/i.exec(param);
    return match !== null;
  });
}

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; problem: "TOO_LARGE" | "NOT_UTF8" };

/**
 * Reads the body up to `maxBytes`, enforcing the limit on the bytes actually
 * streamed (a declared Content-Length is only an early rejection, never
 * trusted as the size). Stops reading as soon as the limit is exceeded.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return { ok: false, problem: "TOO_LARGE" };
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, problem: "TOO_LARGE" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, problem: "NOT_UTF8" };
  }
}

export type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false };

/** Parses a JSON object (not an array, primitive or null). */
export function parseJsonObject(text: string): JsonObjectResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  return { ok: true, value: value as Record<string, unknown> };
}
