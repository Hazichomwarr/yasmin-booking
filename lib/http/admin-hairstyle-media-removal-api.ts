import { resolveAdminSession } from "@/lib/admin/auth";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";
import { MediaCleanupError, removeHairstyleImageAndQueueCleanup } from "@/lib/media/hairstyle-media-cleanup";

import { loadAdminConfig } from "./admin-auth-api";
import { publicJson } from "./public-responses";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

const MAX_REQUEST_BYTES = 4 * 1024;

function response(status: number, code: string, message: string) {
  return publicJson(status, { error: { code, message } });
}

/** POST only: JSON plus Origin checks keep this cookie-authenticated removal CSRF-safe. */
export async function removeHairstyleImageApi(request: Request, hairstyleId: string, mediaId: string): Promise<Response> {
  const config = loadAdminConfig(process.env);
  if (!config) return response(503, "SERVICE_UNAVAILABLE", "Image management is temporarily unavailable.");
  if (checkMutationOrigin(request.headers, new Set([config.appOrigin]))) {
    return response(403, "REQUEST_REJECTED", "This request was not accepted.");
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return response(415, "UNSUPPORTED_CONTENT_TYPE", "Send the request as application/json.");
  }
  const session = await resolveAdminSession(readAdminSessionCookie(request.headers));
  if (!session) return response(401, "SESSION_INVALID", "Your admin session is no longer valid. Sign in again.");
  const body = await readBodyText(request, MAX_REQUEST_BYTES);
  const parsed = body.ok ? parseJsonObject(body.text) : { ok: false as const };
  if (!parsed.ok || Object.keys(parsed.value).length !== 0) {
    return response(400, "INVALID_INPUT", "The image removal request is not valid.");
  }

  try {
    const result = await removeHairstyleImageAndQueueCleanup(hairstyleId, mediaId);
    // Storage pathname is intentionally not returned to the browser.
    return publicJson(200, { removed: true, alreadyRemoved: result.alreadyRemoved });
  } catch (error) {
    if (error instanceof MediaCleanupError && error.code === "MEDIA_NOT_FOUND") {
      return response(404, "MEDIA_NOT_FOUND", "The image was not found.");
    }
    return response(500, "INTERNAL_ERROR", "The image could not be removed.");
  }
}
