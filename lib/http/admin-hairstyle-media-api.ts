import {
  isCatalogError,
  reorderHairstyleMedia,
  updateHairstyleMediaMetadata,
} from "@/lib/catalog";
import { resolveAdminSession } from "@/lib/admin/auth";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";

import { loadAdminConfig } from "./admin-auth-api";
import { publicJson } from "./public-responses";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

const MAX_REQUEST_BYTES = 8 * 1024;

function invalidInput() {
  return publicJson(400, { error: { code: "INVALID_INPUT", message: "The photo change is not valid." } });
}

/** Authenticated parent-scoped gallery mutations; object storage is never touched here. */
export async function patchHairstyleMediaApi(request: Request, hairstyleId: string): Promise<Response> {
  const config = loadAdminConfig(process.env);
  if (!config) return publicJson(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Photo management is temporarily unavailable." } });
  if (checkMutationOrigin(request.headers, new Set([config.appOrigin]))) {
    return publicJson(403, { error: { code: "REQUEST_REJECTED", message: "This request was not accepted." } });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return publicJson(415, { error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "Send the request as application/json." } });
  }
  if (!await resolveAdminSession(readAdminSessionCookie(request.headers))) {
    return publicJson(401, { error: { code: "SESSION_INVALID", message: "Your admin session is no longer valid. Sign in again." } });
  }
  const body = await readBodyText(request, MAX_REQUEST_BYTES);
  const parsed = body.ok ? parseJsonObject(body.text) : { ok: false as const };
  if (!parsed.ok) return invalidInput();

  try {
    if (
      parsed.value.kind === "metadata" &&
      Object.keys(parsed.value).every((key) => ["kind", "mediaId", "altText", "caption"].includes(key)) &&
      typeof parsed.value.mediaId === "string" &&
      (parsed.value.altText === undefined || parsed.value.altText === null || typeof parsed.value.altText === "string") &&
      (parsed.value.caption === undefined || parsed.value.caption === null || typeof parsed.value.caption === "string")
    ) {
      const media = await updateHairstyleMediaMetadata(hairstyleId, parsed.value.mediaId, {
        altText: parsed.value.altText as string | null | undefined,
        caption: parsed.value.caption as string | null | undefined,
      });
      return publicJson(200, { media });
    }
    if (
      parsed.value.kind === "order" &&
      Object.keys(parsed.value).every((key) => ["kind", "orderedMediaIds"].includes(key)) &&
      Array.isArray(parsed.value.orderedMediaIds) &&
      parsed.value.orderedMediaIds.every((id) => typeof id === "string")
    ) {
      const media = await reorderHairstyleMedia(hairstyleId, parsed.value.orderedMediaIds);
      return publicJson(200, { media });
    }
  } catch (error) {
    if (isCatalogError(error, "MEDIA_NOT_FOUND") || isCatalogError(error, "HAIRSTYLE_NOT_FOUND")) {
      return publicJson(404, { error: { code: error.code, message: "The requested photo was not found." } });
    }
    if (isCatalogError(error)) return invalidInput();
    return publicJson(500, { error: { code: "INTERNAL_ERROR", message: "The photo change could not be saved." } });
  }
  return invalidInput();
}
