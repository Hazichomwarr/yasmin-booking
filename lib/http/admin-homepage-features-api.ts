import { resolveAdminSession } from "@/lib/admin/auth";
import { setAdminHomepageFeatures } from "@/lib/admin/catalog";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";
import { HomepageFeatureError, MAX_HOMEPAGE_FEATURES, type HomepageFeatureTarget } from "@/lib/catalog";

import { loadAdminConfig } from "./admin-auth-api";
import { publicJson } from "./public-responses";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

const MAX_BYTES = 8 * 1024;

function invalidInput() {
  return publicJson(400, { error: { code: "INVALID_INPUT", message: "Choose up to four valid homepage features." } });
}

function parseTargets(value: unknown): HomepageFeatureTarget[] | null {
  if (!Array.isArray(value) || value.length > MAX_HOMEPAGE_FEATURES) return null;
  const targets: HomepageFeatureTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const input = item as Record<string, unknown>;
    if (!Object.keys(input).every((key) => key === "hairstyleId" || key === "hairstyleVariantId")) return null;
    if (typeof input.hairstyleId !== "string") return null;
    if (input.hairstyleVariantId !== null && typeof input.hairstyleVariantId !== "string") return null;
    targets.push({ hairstyleId: input.hairstyleId, hairstyleVariantId: input.hairstyleVariantId as string | null });
  }
  return targets;
}

export async function adminHomepageFeaturesPut(request: Request): Promise<Response> {
  const config = loadAdminConfig(process.env);
  if (!config) return publicJson(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Homepage management is temporarily unavailable." } });
  if (checkMutationOrigin(request.headers, new Set([config.appOrigin])) || !isJsonContentType(request.headers.get("content-type"))) {
    return publicJson(403, { error: { code: "REQUEST_REJECTED", message: "This request was not accepted." } });
  }
  const body = await readBodyText(request, MAX_BYTES);
  if (!body.ok) return invalidInput();
  const access = await resolveAdminSession(readAdminSessionCookie(request.headers));
  if (!access) return publicJson(401, { error: { code: "SESSION_INVALID", message: "Your admin session is no longer valid. Sign in again." } });
  const parsed = parseJsonObject(body.text);
  if (!parsed.ok || !Object.keys(parsed.value).every((key) => key === "revision" || key === "features")) return invalidInput();
  const revision = parsed.value.revision;
  const targets = parseTargets(parsed.value.features);
  if (typeof revision !== "string" || targets === null) return invalidInput();

  try {
    return publicJson(200, { state: await setAdminHomepageFeatures(access, targets, revision) });
  } catch (error) {
    if (error instanceof HomepageFeatureError && error.code === "STALE_FEATURE_CONFIGURATION") {
      return publicJson(409, { error: { code: error.code, message: "The featured list changed in another admin session. Refresh and try again." } });
    }
    if (error instanceof HomepageFeatureError) return invalidInput();
    throw error;
  }
}
