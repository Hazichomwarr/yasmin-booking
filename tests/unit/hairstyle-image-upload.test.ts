import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

  it("binds current permissions to their gallery while retaining version 1 service permissions", () => {
    const variant = issueHairstyleImageUploadIntent(
      storage,
      { hairstyleId: "style_1", hairstyleVariantId: "variant_1", contentType: "image/jpeg" },
      { now: 1_000, randomId: () => "variant-object" },
    );
    assert.equal(variant.pathname, "hairstyles/style_1/variants/variant_1/variant-object.jpg");
    assert.equal(
      verifyHairstyleImageUploadIntent(variant.clientPayload, storage, {
        hairstyleId: "style_1",
        hairstyleVariantId: "variant_1",
      }, { now: 1_001 }).hairstyleVariantId,
      "variant_1",
    );
    assert.throws(
      () => verifyHairstyleImageUploadIntent(variant.clientPayload, storage, {
        hairstyleId: "style_1",
        hairstyleVariantId: "variant_2",
      }, { now: 1_001 }),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_UPLOAD_INTENT",
    );

    const legacy = {
      v: 1,
      hairstyleId: "style_1",
      pathname: "hairstyles/style_1/legacy.jpg",
      contentType: "image/jpeg",
      validUntil: 2_000,
    };
    const encoded = Buffer.from(JSON.stringify(legacy), "utf8").toString("base64url");
    const clientPayload = `${encoded}.${createHmac("sha256", storage.token).update(encoded, "utf8").digest("base64url")}`;
    assert.equal(
      verifyHairstyleImageUploadIntent(clientPayload, storage, { hairstyleId: "style_1" }, { now: 1_001 }).hairstyleVariantId,
      null,
    );
  });

  it("signs the exact replacement identity and expected existing state", () => {
    const intent = issueHairstyleImageUploadIntent(
      storage,
      {
        hairstyleId: "style_1",
        hairstyleVariantId: "variant_1",
        contentType: "image/png",
        replacement: {
          mediaId: "media_1",
          storageKey: "hairstyles/style_1/old.png",
          updatedAt: "2026-11-07T12:00:00.000Z",
        },
      },
      { now: 1_000, randomId: () => "replacement-object" },
    );
    const verified = verifyHairstyleImageUploadIntent(intent.clientPayload, storage, {
      hairstyleId: "style_1",
      hairstyleVariantId: "variant_1",
      pathname: intent.pathname,
    }, { now: 1_001 });

    assert.deepEqual(verified.replacement, {
      mediaId: "media_1",
      storageKey: "hairstyles/style_1/old.png",
      updatedAt: "2026-11-07T12:00:00.000Z",
    });
    assert.throws(
      () => issueHairstyleImageUploadIntent(storage, {
        hairstyleId: "style_1",
        contentType: "image/png",
        replacement: { mediaId: "", storageKey: "old.png", updatedAt: "not-a-date" },
      }),
      (error: unknown) => error instanceof HairstyleImageUploadError && error.code === "INVALID_UPLOAD_INTENT",
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
