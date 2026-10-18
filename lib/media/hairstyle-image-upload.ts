import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { parseBlobPublicBaseUrl } from "./blob-public-origin";

export const HAIRSTYLE_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type HairstyleImageContentType = (typeof HAIRSTYLE_IMAGE_CONTENT_TYPES)[number];

export const MAX_HAIRSTYLE_IMAGE_BYTES = 10 * 1024 * 1024;
export const UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;

const UPLOAD_INTENT_VERSION = 1;
const COMPLETION_GRACE_MS = 60 * 60 * 1000;

export type BlobStorageConfig = {
  token: string;
  publicBaseUrl: string;
};

export type HairstyleImageUploadIntent = {
  hairstyleId: string;
  pathname: string;
  contentType: HairstyleImageContentType;
  validUntil: number;
  clientPayload: string;
};

export type BlobObjectMetadata = {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
};

export class HairstyleImageUploadError extends Error {
  constructor(
    public readonly code:
      | "MEDIA_STORAGE_UNAVAILABLE"
      | "INVALID_UPLOAD_INTENT"
      | "UPLOAD_INTENT_EXPIRED"
      | "INVALID_MEDIA_OBJECT",
    message: string,
  ) {
    super(message);
    this.name = "HairstyleImageUploadError";
  }
}

type SignedIntent = {
  v: number;
  hairstyleId: string;
  pathname: string;
  contentType: HairstyleImageContentType;
  validUntil: number;
};

function isImageContentType(value: unknown): value is HairstyleImageContentType {
  return typeof value === "string" && (HAIRSTYLE_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

function extensionFor(contentType: HairstyleImageContentType) {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function encode(value: SignedIntent) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(encoded: string, token: string) {
  return createHmac("sha256", token).update(encoded, "utf8").digest("base64url");
}

function sameSignature(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Reads only server-side configuration. The public base URL is not a secret. */
export function loadBlobStorageConfig(
  env: Readonly<Record<string, string | undefined>>,
): BlobStorageConfig | null {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  const publicBaseUrl = parseBlobPublicBaseUrl(env.BLOB_PUBLIC_BASE_URL);
  if (!token || !publicBaseUrl) return null;
  return { token, publicBaseUrl };
}

/**
 * Creates an immutable destination and its opaque, server-signed payload.
 * The payload is accepted only by the completion endpoint after Vercel Blob
 * has authenticated the callback; it is never a Blob read-write credential.
 */
export function issueHairstyleImageUploadIntent(
  config: BlobStorageConfig,
  input: { hairstyleId: string; contentType: unknown },
  options: { now?: number; randomId?: () => string } = {},
): HairstyleImageUploadIntent {
  if (typeof input.hairstyleId !== "string" || input.hairstyleId.trim().length === 0 || !isImageContentType(input.contentType)) {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  }
  const hairstyleId = input.hairstyleId.trim();
  const now = options.now ?? Date.now();
  const validUntil = now + UPLOAD_INTENT_TTL_MS;
  const pathname = `hairstyles/${hairstyleId}/${(options.randomId ?? randomUUID)()}.${extensionFor(input.contentType)}`;
  const signed: SignedIntent = {
    v: UPLOAD_INTENT_VERSION,
    hairstyleId,
    pathname,
    contentType: input.contentType,
    validUntil,
  };
  const encoded = encode(signed);
  return { ...signed, clientPayload: `${encoded}.${sign(encoded, config.token)}` };
}

function readIntent(clientPayload: unknown, config: BlobStorageConfig): SignedIntent {
  if (typeof clientPayload !== "string") {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  }
  const separator = clientPayload.lastIndexOf(".");
  if (separator < 1) throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  const encoded = clientPayload.slice(0, separator);
  const signature = clientPayload.slice(separator + 1);
  if (!sameSignature(signature, sign(encoded, config.token))) {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  }
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SignedIntent>;
    if (
      decoded.v !== UPLOAD_INTENT_VERSION ||
      typeof decoded.hairstyleId !== "string" ||
      typeof decoded.pathname !== "string" ||
      !isImageContentType(decoded.contentType) ||
      !Number.isSafeInteger(decoded.validUntil)
    ) {
      throw new Error("invalid");
    }
    return decoded as SignedIntent;
  } catch {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  }
}

export function verifyHairstyleImageUploadIntent(
  clientPayload: unknown,
  config: BlobStorageConfig,
  expected: { hairstyleId: string; pathname?: string },
  options: { now?: number; completion?: boolean } = {},
): SignedIntent {
  const intent = readIntent(clientPayload, config);
  const now = options.now ?? Date.now();
  const deadline = intent.validUntil + (options.completion ? COMPLETION_GRACE_MS : 0);
  if (now > deadline) {
    throw new HairstyleImageUploadError("UPLOAD_INTENT_EXPIRED", "This image upload authorization has expired.");
  }
  if (intent.hairstyleId !== expected.hairstyleId || (expected.pathname && intent.pathname !== expected.pathname)) {
    throw new HairstyleImageUploadError("INVALID_UPLOAD_INTENT", "The image upload request is invalid.");
  }
  return intent;
}

/** Validates provider metadata after an upload, before catalog attachment. */
export function validateUploadedHairstyleImage(
  object: BlobObjectMetadata,
  config: BlobStorageConfig,
  intent: Pick<SignedIntent, "pathname" | "contentType">,
): BlobObjectMetadata {
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > MAX_HAIRSTYLE_IMAGE_BYTES
  ) {
    throw new HairstyleImageUploadError("INVALID_MEDIA_OBJECT", "The uploaded image could not be verified.");
  }
  assertUploadedHairstyleImageIdentity(object, config, intent);
  return object;
}

/** Checks callback identity before any provider metadata lookup. */
export function assertUploadedHairstyleImageIdentity(
  object: Pick<BlobObjectMetadata, "url" | "pathname" | "contentType">,
  config: BlobStorageConfig,
  intent: Pick<SignedIntent, "pathname" | "contentType">,
): void {
  if (
    typeof object.url !== "string" ||
    typeof object.pathname !== "string" ||
    !isImageContentType(object.contentType) ||
    object.pathname !== intent.pathname ||
    object.contentType !== intent.contentType
  ) {
    throw new HairstyleImageUploadError("INVALID_MEDIA_OBJECT", "The uploaded image could not be verified.");
  }
  let url: URL;
  try {
    url = new URL(object.url);
  } catch {
    throw new HairstyleImageUploadError("INVALID_MEDIA_OBJECT", "The uploaded image could not be verified.");
  }
  if (
    url.origin !== config.publicBaseUrl ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname.slice(1)) !== intent.pathname
  ) {
    throw new HairstyleImageUploadError("INVALID_MEDIA_OBJECT", "The uploaded image could not be verified.");
  }
}
