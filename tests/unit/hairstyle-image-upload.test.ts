import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_HAIRSTYLE_IMAGE_BYTES,
  HairstyleImageUploadError,
  issueHairstyleImageUploadIntent,
  validateUploadedHairstyleImage,
  verifyHairstyleImageUploadIntent,
} from "@/lib/media/hairstyle-image-upload";

const storage = {
  token: "blob-test-token-that-never-leaves-this-unit-test",
  publicBaseUrl: "https://store.public.blob.vercel-storage.com",
};

describe("hairstyle image upload intent", () => {
  it("creates an immutable hairstyle-scoped path and verifies its signature", () => {
    const intent = issueHairstyleImageUploadIntent(
      storage,
      { hairstyleId: "style_1", contentType: "image/webp" },
      { now: 1_000, randomId: () => "random-object" },
    );

    assert.equal(intent.pathname, "hairstyles/style_1/random-object.webp");
    assert.equal(
      verifyHairstyleImageUploadIntent(intent.clientPayload, storage, {
        hairstyleId: "style_1",
        pathname: intent.pathname,
      }, { now: 1_001 }).pathname,
      intent.pathname,
    );
  });

  it("rejects unsupported types, tampering, expiry, and provider objects outside policy", () => {
    assert.throws(
      () => issueHairstyleImageUploadIntent(storage, { hairstyleId: "style_1", contentType: "image/gif" }),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_UPLOAD_INTENT",
    );
    const intent = issueHairstyleImageUploadIntent(
      storage,
      { hairstyleId: "style_1", contentType: "image/jpeg" },
      { now: 1_000, randomId: () => "random-object" },
    );
    assert.throws(
      () => verifyHairstyleImageUploadIntent(`${intent.clientPayload}x`, storage, { hairstyleId: "style_1" }, { now: 1_001 }),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_UPLOAD_INTENT",
    );
    assert.throws(
      () => verifyHairstyleImageUploadIntent(intent.clientPayload, storage, { hairstyleId: "style_1" }, { now: intent.validUntil + 1 }),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "UPLOAD_INTENT_EXPIRED",
    );
    assert.throws(
      () => validateUploadedHairstyleImage({
        pathname: intent.pathname,
        url: `https://other.example/${intent.pathname}`,
        contentType: "image/jpeg",
        size: 100,
      }, storage, intent),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_MEDIA_OBJECT",
    );
    assert.throws(
      () => validateUploadedHairstyleImage({
        pathname: intent.pathname,
        url: `${storage.publicBaseUrl}/${intent.pathname}`,
        contentType: "image/jpeg",
        size: MAX_HAIRSTYLE_IMAGE_BYTES + 1,
      }, storage, intent),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_MEDIA_OBJECT",
    );
  });
});
