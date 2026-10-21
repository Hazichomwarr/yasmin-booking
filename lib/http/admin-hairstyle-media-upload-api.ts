import type { HandleUploadBody } from "@vercel/blob/client";

import { resolveAdminSession, type AdminAccess } from "@/lib/admin/auth";
import { readAdminSessionCookie } from "@/lib/admin/session-cookie";
import {
  attachHairstyleImageIdempotently,
  getHairstyleDetailForAdmin,
  isCatalogError,
  listHairstyleMedia,
  MEDIA_LIMITS,
} from "@/lib/catalog";
import {
  HAIRSTYLE_IMAGE_CONTENT_TYPES,
  MAX_HAIRSTYLE_IMAGE_BYTES,
  HairstyleImageUploadError,
  assertUploadedHairstyleImageIdentity,
  issueHairstyleImageUploadIntent,
  loadBlobStorageConfig,
  validateUploadedHairstyleImage,
  verifyHairstyleImageUploadIntent,
} from "@/lib/media/hairstyle-image-upload";
import {
  vercelBlobClientGateway,
  type BlobClientUploadGateway,
} from "@/lib/media/vercel-blob-client";
import { queueUnattachedHairstyleImageCleanup } from "@/lib/media/hairstyle-media-cleanup";

import { loadAdminConfig, type AdminConfig } from "./admin-auth-api";
import { publicJson } from "./public-responses";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

const MAX_UPLOAD_REQUEST_BYTES = 32 * 1024;

class MediaAttachmentPendingReconciliationError extends Error {
  constructor(public readonly pathname: string, cause: unknown) {
    super("Uploaded image metadata could not be attached.", { cause });
    this.name = "MediaAttachmentPendingReconciliationError";
  }
}

type AdminMediaDetail = Awaited<ReturnType<typeof getHairstyleDetailForAdmin>>;

export type AdminHairstyleMediaUploadApiDeps = {
  env: () => Readonly<Record<string, string | undefined>>;
  resolveSession: typeof resolveAdminSession;
  getHairstyle: (id: string) => Promise<AdminMediaDetail>;
  listMedia: typeof listHairstyleMedia;
  attachImage: typeof attachHairstyleImageIdempotently;
  queueUnattachedCleanup: typeof queueUnattachedHairstyleImageCleanup;
  blob: BlobClientUploadGateway;
  log: (entry: { outcome: string; hairstyleId: string; pathname?: string }) => void;
};

const defaultDeps: AdminHairstyleMediaUploadApiDeps = {
  env: () => process.env,
  resolveSession: resolveAdminSession,
  getHairstyle: getHairstyleDetailForAdmin,
  listMedia: listHairstyleMedia,
  attachImage: attachHairstyleImageIdempotently,
  queueUnattachedCleanup: queueUnattachedHairstyleImageCleanup,
  blob: vercelBlobClientGateway,
  log: (entry) => console.error(JSON.stringify({ event: "admin-hairstyle-image-upload", ...entry })),
};

function response(status: number, code: string, message: string) {
  return publicJson(status, { error: { code, message } });
}

function isImageContentType(value: unknown): value is (typeof HAIRSTYLE_IMAGE_CONTENT_TYPES)[number] {
  return typeof value === "string" && (HAIRSTYLE_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

function isVariantId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseGalleryVariantId(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (value === null || isVariantId(value)) return value === null ? null : value.trim();
  return undefined;
}

async function countGalleryImages(
  hairstyleId: string,
  hairstyleVariantId: string | null,
  deps: AdminHairstyleMediaUploadApiDeps,
) {
  const hairstyle = await deps.getHairstyle(hairstyleId);
  if (hairstyleVariantId !== null && !hairstyle.variants.some((variant) => variant.id === hairstyleVariantId)) {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The selected variant does not belong to this hairstyle.");
  }
  const media = await deps.listMedia(hairstyleId, hairstyleVariantId);
  return media.filter((item) => item.type === "IMAGE").length;
}

function parseUploadBody(input: Record<string, unknown>): HandleUploadBody | null {
  if (
    (input.type !== "blob.generate-client-token" && input.type !== "blob.upload-completed") ||
    input.payload === null ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    return null;
  }
  return input as unknown as HandleUploadBody;
}

type AdminMutationAuthorization = { access: AdminAccess } | { response: Response };

async function authorizeAdminMutation(
  request: Request,
  config: AdminConfig,
  deps: AdminHairstyleMediaUploadApiDeps,
): Promise<AdminMutationAuthorization> {
  if (checkMutationOrigin(request.headers, new Set([config.appOrigin]))) {
    return { response: response(403, "REQUEST_REJECTED", "This request was not accepted.") } as const;
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { response: response(415, "UNSUPPORTED_CONTENT_TYPE", "Send the request as application/json.") } as const;
  }
  const access = await deps.resolveSession(readAdminSessionCookie(request.headers));
  if (!access) {
    return { response: response(401, "SESSION_INVALID", "Your admin session is no longer valid. Sign in again.") } as const;
  }
  return { access } as const;
}

async function readJsonBody(request: Request) {
  const body = await readBodyText(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!body.ok) return null;
  const parsed = parseJsonObject(body.text);
  return parsed.ok ? parsed.value : null;
}

/** POST: creates an opaque, hairstyle-scoped pathname and client payload. */
export async function createHairstyleImageUploadIntentApi(
  request: Request,
  hairstyleId: string,
  deps: AdminHairstyleMediaUploadApiDeps = defaultDeps,
): Promise<Response> {
  const env = deps.env();
  const adminConfig = loadAdminConfig(env);
  const storage = loadBlobStorageConfig(env);
  if (!adminConfig || !storage) return response(503, "SERVICE_UNAVAILABLE", "Image uploads are temporarily unavailable.");
  const authorized = await authorizeAdminMutation(request, adminConfig, deps);
  if ("response" in authorized) return authorized.response;
  const input = await readJsonBody(request);
  const hairstyleVariantId = input && parseGalleryVariantId(input.hairstyleVariantId);
  if (
    !input ||
    ![1, 2].includes(Object.keys(input).length) ||
    !Object.keys(input).every((key) => key === "contentType" || key === "hairstyleVariantId") ||
    !isImageContentType(input.contentType) ||
    hairstyleVariantId === undefined
  ) {
    return response(400, "INVALID_INPUT", "Choose a supported image type.");
  }

  try {
    if (await countGalleryImages(hairstyleId, hairstyleVariantId, deps) >= MEDIA_LIMITS.IMAGE) {
      return response(409, "MEDIA_LIMIT_REACHED", "This gallery already has the maximum number of images.");
    }
    const intent = issueHairstyleImageUploadIntent(storage, {
      hairstyleId,
      hairstyleVariantId,
      contentType: input.contentType,
    });
    return publicJson(201, {
      pathname: intent.pathname,
      clientPayload: intent.clientPayload,
      uploadUrl: `/api/admin/hairstyles/${encodeURIComponent(hairstyleId)}/media/upload`,
      confirmUrl: `/api/admin/hairstyles/${encodeURIComponent(hairstyleId)}/media/upload/confirm`,
      validUntil: intent.validUntil,
    });
  } catch (error) {
    if (error instanceof HairstyleImageUploadError) {
      return response(400, error.code, error.message);
    }
    return response(404, "HAIRSTYLE_NOT_FOUND", "The hairstyle was not found.");
  }
}

function confirmationFailure(error: unknown) {
  if (error instanceof HairstyleImageUploadError) {
    return error.code === "UPLOAD_INTENT_EXPIRED"
      ? response(400, error.code, "This photo's upload authorization expired. Remove it and select the photo again.")
      : response(400, error.code, "The uploaded photo could not be verified. Remove it and select the photo again.");
  }
  if (isCatalogError(error, "MEDIA_LIMIT_REACHED")) {
    return response(409, error.code, `This hairstyle already has the maximum of ${MEDIA_LIMITS.IMAGE} photos.`);
  }
  if (isCatalogError(error, "HAIRSTYLE_NOT_FOUND")) {
    return response(404, error.code, "The hairstyle was not found.");
  }
  if (isCatalogError(error)) {
    return response(409, error.code, "The uploaded photo could not be added to this hairstyle.");
  }
  return null;
}

/**
 * POST: the signed-in owner's confirmation that a direct upload finished.
 * Vercel Blob only sends completion callbacks to a publicly reachable
 * deployment, so a local server never receives them. Attachment is keyed by
 * the signed storage key: retried confirmations and a later provider callback
 * converge on the same record.
 */
export async function confirmHairstyleImageUploadApi(
  request: Request,
  hairstyleId: string,
  deps: AdminHairstyleMediaUploadApiDeps = defaultDeps,
): Promise<Response> {
  const env = deps.env();
  const adminConfig = loadAdminConfig(env);
  const storage = loadBlobStorageConfig(env);
  if (!adminConfig || !storage) return response(503, "SERVICE_UNAVAILABLE", "Image uploads are temporarily unavailable.");
  const authorized = await authorizeAdminMutation(request, adminConfig, deps);
  if ("response" in authorized) return authorized.response;
  const input = await readJsonBody(request);
  if (!input || Object.keys(input).length !== 2 || typeof input.clientPayload !== "string" || typeof input.url !== "string") {
    return response(400, "INVALID_INPUT", "The uploaded photo could not be identified.");
  }

  let pathname: string | undefined;
  try {
    const intent = verifyHairstyleImageUploadIntent(input.clientPayload, storage, { hairstyleId }, { completion: true });
    pathname = intent.pathname;
    // Checks the exact Blob origin before the provider lookup.
    assertUploadedHairstyleImageIdentity({ url: input.url, pathname: intent.pathname, contentType: intent.contentType }, storage, intent);
    let verified;
    try {
      verified = validateUploadedHairstyleImage(await deps.blob.head(input.url, storage.token), storage, intent);
    } catch (error) {
      if (error instanceof HairstyleImageUploadError) throw error;
      deps.log({ outcome: "UPLOAD_CONFIRMATION_OBJECT_UNAVAILABLE", hairstyleId, pathname });
      return response(502, "MEDIA_STORAGE_UNAVAILABLE", "The uploaded photo could not be found in storage. Retry the upload.");
    }
    try {
      const { media } = await deps.attachImage({
        hairstyleId: intent.hairstyleId,
        hairstyleVariantId: intent.hairstyleVariantId,
        storageKey: verified.pathname,
        deliveryUrl: verified.url,
      });
      return publicJson(200, { media });
    } catch (error) {
      // The direct upload may have succeeded even when attachment loses a
      // capacity race or rejects a cross-gallery path. Queue delayed cleanup
      // for every failed attachment; the worker rechecks that no media record
      // owns this storage key before it ever deletes anything.
      await deps.queueUnattachedCleanup(intent.hairstyleId, verified.pathname).catch(() => undefined);
      if (isCatalogError(error)) throw error;
      deps.log({ outcome: "UPLOAD_CONFIRMATION_PENDING_RECONCILIATION", hairstyleId, pathname });
      return response(503, "MEDIA_ATTACHMENT_PENDING_RECONCILIATION", "The photo uploaded but could not be saved to the gallery. Retry to attach it.");
    }
  } catch (error) {
    const failure = confirmationFailure(error);
    if (!failure) throw error;
    deps.log({
      outcome: error instanceof HairstyleImageUploadError || isCatalogError(error) ? error.code : "UPLOAD_CONFIRMATION_REJECTED",
      hairstyleId,
      pathname,
    });
    return failure;
  }
}

/**
 * Vercel Blob's one endpoint for client-token issuance and provider-signed
 * upload completion callbacks. Completion callbacks have no browser session;
 * handleUpload verifies their provider signature before this callback runs.
 */
export async function handleHairstyleImageUploadApi(
  request: Request,
  hairstyleId: string,
  deps: AdminHairstyleMediaUploadApiDeps = defaultDeps,
): Promise<Response> {
  const env = deps.env();
  const storage = loadBlobStorageConfig(env);
  if (!storage) return response(503, "SERVICE_UNAVAILABLE", "Image uploads are temporarily unavailable.");
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return response(415, "UNSUPPORTED_CONTENT_TYPE", "Send the request as application/json.");
  }
  const input = await readJsonBody(request);
  const body = input && parseUploadBody(input);
  if (!body) return response(400, "INVALID_INPUT", "The upload request is not valid.");

  if (body.type === "blob.generate-client-token") {
    const adminConfig = loadAdminConfig(env);
    if (!adminConfig) return response(503, "SERVICE_UNAVAILABLE", "Image uploads are temporarily unavailable.");
    const authorized = await authorizeAdminMutation(request, adminConfig, deps);
    if ("response" in authorized) return authorized.response;
  }

  try {
    const result = await deps.blob.handle({
      token: storage.token,
      request,
      body,
      callbacks: {
        onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
          if (multipart) {
            throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "This image upload request is invalid.");
          }
          const intent = verifyHairstyleImageUploadIntent(clientPayload, storage, { hairstyleId, pathname });
          if (await countGalleryImages(hairstyleId, intent.hairstyleVariantId, deps) >= MEDIA_LIMITS.IMAGE) {
            throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "This gallery already has the maximum number of images.");
          }
          return {
            allowedContentTypes: [...HAIRSTYLE_IMAGE_CONTENT_TYPES],
            maximumSizeInBytes: MAX_HAIRSTYLE_IMAGE_BYTES,
            validUntil: intent.validUntil,
            addRandomSuffix: false,
            allowOverwrite: false,
            tokenPayload: clientPayload!,
          };
        },
        onUploadCompleted: async ({ blob, tokenPayload }) => {
          const intent = verifyHairstyleImageUploadIntent(tokenPayload, storage, { hairstyleId }, { completion: true });
          assertUploadedHairstyleImageIdentity(blob, storage, intent);
          const metadata = await deps.blob.head(blob.url, storage.token);
          const verified = validateUploadedHairstyleImage(metadata, storage, intent);
          try {
            await deps.attachImage({
              hairstyleId: intent.hairstyleId,
              hairstyleVariantId: intent.hairstyleVariantId,
              storageKey: verified.pathname,
              deliveryUrl: verified.url,
            });
          } catch (error) {
            // The callback may be retried by Vercel Blob. Preserve that path
            // for a grace period, then let the durable worker remove an object
            // that remains unattached. The task stores no provider credential.
            await deps.queueUnattachedCleanup(intent.hairstyleId, verified.pathname);
            if (isCatalogError(error)) throw error;
            throw new MediaAttachmentPendingReconciliationError(verified.pathname, error);
          }
        },
      },
    });
    return publicJson(200, result);
  } catch (error) {
    const pathname = error instanceof MediaAttachmentPendingReconciliationError
      ? error.pathname
      : input && typeof input.payload === "object" && input.payload !== null && "pathname" in input.payload && typeof input.payload.pathname === "string"
        ? input.payload.pathname
        : undefined;
    deps.log({
      outcome: error instanceof HairstyleImageUploadError ? error.code : "UPLOAD_COMPLETION_PENDING_RECONCILIATION",
      hairstyleId,
      pathname,
    });
    if (error instanceof HairstyleImageUploadError) {
      return response(400, error.code, "The image upload could not be accepted.");
    }
    if (isCatalogError(error)) {
      const status = error.code === "MEDIA_LIMIT_REACHED" || error.code === "STORAGE_KEY_ALREADY_EXISTS" ? 409 : 400;
      return response(status, error.code, "The image upload could not be finalized.");
    }
    // A durable cleanup task was queued before this non-2xx response, so Blob
    // callback retries can still attach the object during its grace period.
    return response(503, "MEDIA_ATTACHMENT_PENDING_RECONCILIATION", "The image upload could not be finalized yet.");
  }
}
