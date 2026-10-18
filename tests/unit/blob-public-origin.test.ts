import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isApprovedBlobDeliveryUrl, parseBlobPublicBaseUrl } from "@/lib/media/blob-public-origin";

describe("public Blob image origin", () => {
  it("accepts one exact HTTPS Blob origin and its hairstyle delivery URLs", () => {
    const origin = "https://yasmin-public.blob.vercel-storage.com";
    assert.equal(parseBlobPublicBaseUrl(origin), origin);
    assert.equal(isApprovedBlobDeliveryUrl(`${origin}/hairstyles/style-1/photo.webp`, origin), true);
  });

  it("fails closed for absent, malformed, or nonmatching configuration", () => {
    assert.equal(parseBlobPublicBaseUrl(undefined), null);
    assert.equal(parseBlobPublicBaseUrl("http://yasmin-public.blob.vercel-storage.com"), null);
    assert.equal(parseBlobPublicBaseUrl("https://yasmin-public.blob.vercel-storage.com/path"), null);
    assert.equal(parseBlobPublicBaseUrl("https://yasmin-public.blob.vercel-storage.com:444"), null);
    assert.equal(isApprovedBlobDeliveryUrl("https://other.blob.vercel-storage.com/hairstyles/style-1/photo.webp", "https://yasmin-public.blob.vercel-storage.com"), false);
    assert.equal(isApprovedBlobDeliveryUrl("https://yasmin-public.blob.vercel-storage.com/other/photo.webp", "https://yasmin-public.blob.vercel-storage.com"), false);
    assert.equal(isApprovedBlobDeliveryUrl("https://yasmin-public.blob.vercel-storage.com/hairstyles/style-1/photo.webp?token=no", "https://yasmin-public.blob.vercel-storage.com"), false);
  });
});
