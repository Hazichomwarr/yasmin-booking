import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as catalog from "@/lib/catalog";
import {
  attachHairstyleImage,
  attachVerifiedHairstyleVideo,
  createCategory,
  createHairstyle,
  isCatalogError,
  listHairstyleMedia,
  removeHairstyleMediaMetadata,
  reorderHairstyleMedia,
  type AttachHairstyleImageInput,
} from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { assertCatalogError } from "../support/assertions";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("hairstyle media metadata", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function newHairstyle(slug = "knotless") {
    const category =
      (await prisma.hairstyleCategory.findUnique({ where: { slug: "braids" } })) ??
      (await createCategory({ name: "Braids", slug: "braids" }));
    return createHairstyle({ categoryId: category.id, name: slug, slug });
  }

  function attachImage(hairstyleId: string, storageKey: string) {
    return attachHairstyleImage({ hairstyleId, storageKey });
  }

  function attachVerifiedVideo(hairstyleId: string, storageKey: string, durationSeconds = 20) {
    // Stands in for the future server-side ingestion adapter, which measures the stored asset.
    return attachVerifiedHairstyleVideo({
      hairstyleId,
      storageKey,
      verifiedVideo: { storageKey, durationSeconds },
    });
  }

  it("attaches IMAGE metadata with normalized fields", async () => {
    const hairstyle = await newHairstyle();
    const media = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "  styles/knotless/1.jpg ",
      deliveryUrl: " https://cdn.example/1.jpg ",
      altText: "  Waist-length knotless braids ",
      caption: "   ",
    });

    assert.equal(media.type, "IMAGE");
    assert.equal(media.storageKey, "styles/knotless/1.jpg");
    assert.equal(media.deliveryUrl, "https://cdn.example/1.jpg");
    assert.equal(media.altText, "Waist-length knotless braids");
    assert.equal(media.caption, null);
  });

  it("rejects media for a missing hairstyle or blank storage key", async () => {
    const hairstyle = await newHairstyle();
    await assertCatalogError(attachImage("missing-id", "a.jpg"), "HAIRSTYLE_NOT_FOUND");
    await assertCatalogError(attachImage(hairstyle.id, "   "), "INVALID_MEDIA");
    await assertCatalogError(
      attachVerifiedHairstyleVideo({
        hairstyleId: "missing-id",
        storageKey: "v/a.mp4",
        verifiedVideo: { storageKey: "v/a.mp4", durationSeconds: 10 },
      }),
      "HAIRSTYLE_NOT_FOUND",
    );
  });

  it("the ordinary image path cannot attach a VIDEO", async () => {
    const hairstyle = await newHairstyle();

    // No generic attach function is exposed.
    assert.equal("attachHairstyleMedia" in catalog, false);

    // An untyped caller trying to smuggle a video through the image path is rejected.
    const smuggled = {
      hairstyleId: hairstyle.id,
      storageKey: "v/smuggled.mp4",
      type: "VIDEO",
      verifiedVideo: { storageKey: "v/smuggled.mp4", durationSeconds: 5 },
    } as AttachHairstyleImageInput;
    await assertCatalogError(attachHairstyleImage(smuggled), "INVALID_MEDIA");

    assert.equal(await prisma.hairstyleMedia.count({ where: { type: "VIDEO" } }), 0);
  });

  it("the verified-video path accepts videos up to 30 seconds", async () => {
    const hairstyle = await newHairstyle();

    const video = await attachVerifiedVideo(hairstyle.id, "v/ok.mp4", 30);

    assert.equal(video.type, "VIDEO");
    assert.equal(video.storageKey, "v/ok.mp4");
    assert.deepEqual((await listHairstyleMedia(hairstyle.id)).map((m) => m.id), [video.id]);
  });

  it("the verified-video path rejects videos over 30 seconds", async () => {
    const hairstyle = await newHairstyle();

    await assertCatalogError(attachVerifiedVideo(hairstyle.id, "v/long.mp4", 31), "VIDEO_TOO_LONG");
    assert.deepEqual(await listHairstyleMedia(hairstyle.id), []);
  });

  it("the verified-video path rejects metadata measured for a different storage key", async () => {
    const hairstyle = await newHairstyle();

    await assertCatalogError(
      attachVerifiedHairstyleVideo({
        hairstyleId: hairstyle.id,
        storageKey: "v/attached.mp4",
        verifiedVideo: { storageKey: "v/measured-other.mp4", durationSeconds: 10 },
      }),
      "VIDEO_NOT_VERIFIED",
    );
    assert.deepEqual(await listHairstyleMedia(hairstyle.id), []);
  });

  it("allows 8 images and rejects the 9th", async () => {
    const hairstyle = await newHairstyle();
    for (let i = 1; i <= 8; i++) await attachImage(hairstyle.id, `img/${i}.jpg`);

    await assertCatalogError(attachImage(hairstyle.id, "img/9.jpg"), "MEDIA_LIMIT_REACHED");
    // Videos have their own limit.
    await attachVerifiedVideo(hairstyle.id, "v/1.mp4");
    assert.equal(await prisma.hairstyleMedia.count({ where: { type: "IMAGE" } }), 8);
  });

  it("allows 3 videos and rejects the 4th", async () => {
    const hairstyle = await newHairstyle();
    for (let i = 1; i <= 3; i++) await attachVerifiedVideo(hairstyle.id, `v/${i}.mp4`);

    await assertCatalogError(attachVerifiedVideo(hairstyle.id, "v/4.mp4"), "MEDIA_LIMIT_REACHED");
    // Images have their own limit.
    await attachImage(hairstyle.id, "img/1.jpg");
    assert.equal(await prisma.hairstyleMedia.count({ where: { type: "VIDEO" } }), 3);
  });

  it("limits are per hairstyle", async () => {
    const full = await newHairstyle("full");
    const other = await newHairstyle("other");
    for (let i = 1; i <= 8; i++) await attachImage(full.id, `full/${i}.jpg`);

    await attachImage(other.id, "other/1.jpg");
  });

  it("enforces the image limit under concurrent attaches", async () => {
    const hairstyle = await newHairstyle();
    const attempts = Array.from({ length: 12 }, (_, i) => attachImage(hairstyle.id, `race/${i}.jpg`));

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 8);
    assert.equal(rejected.length, 4);
    for (const r of rejected) assert.ok(isCatalogError(r.reason, "MEDIA_LIMIT_REACHED"), String(r.reason));
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: hairstyle.id } }), 8);
  });

  it("enforces the video limit under concurrent verified attaches", async () => {
    const hairstyle = await newHairstyle();
    const attempts = Array.from({ length: 6 }, (_, i) =>
      attachVerifiedVideo(hairstyle.id, `race/${i}.mp4`),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 3);
    assert.equal(rejected.length, 3);
    for (const r of rejected) assert.ok(isCatalogError(r.reason, "MEDIA_LIMIT_REACHED"), String(r.reason));
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: hairstyle.id, type: "VIDEO" } }), 3);
  });

  it("reports a duplicate storage key as a domain error", async () => {
    const first = await newHairstyle("first");
    const second = await newHairstyle("second");
    await attachImage(first.id, "shared.jpg");

    await assertCatalogError(attachImage(second.id, "shared.jpg"), "STORAGE_KEY_ALREADY_EXISTS");
    assert.deepEqual(await listHairstyleMedia(second.id), []);
  });

  it("reorders media for a hairstyle", async () => {
    const hairstyle = await newHairstyle();
    const a = await attachImage(hairstyle.id, "a.jpg");
    const b = await attachImage(hairstyle.id, "b.jpg");
    const v = await attachVerifiedVideo(hairstyle.id, "v.mp4");

    assert.deepEqual((await listHairstyleMedia(hairstyle.id)).map((m) => m.id), [a.id, b.id, v.id]);

    const result = await reorderHairstyleMedia(hairstyle.id, [v.id, b.id, a.id]);
    assert.deepEqual(result.map((m) => m.id), [v.id, b.id, a.id]);
  });

  it("rejects reordering media from another hairstyle and leaves it untouched", async () => {
    const mine = await newHairstyle("mine");
    const theirs = await newHairstyle("theirs");
    const a = await attachImage(mine.id, "mine/a.jpg");
    const foreign = await attachImage(theirs.id, "theirs/a.jpg");

    await assertCatalogError(reorderHairstyleMedia(mine.id, [foreign.id, a.id]), "INVALID_REORDER");
    await assertCatalogError(reorderHairstyleMedia(mine.id, [foreign.id]), "INVALID_REORDER");
    await assertCatalogError(reorderHairstyleMedia("missing-id", []), "HAIRSTYLE_NOT_FOUND");

    const foreignAfter = await prisma.hairstyleMedia.findUniqueOrThrow({ where: { id: foreign.id } });
    assert.equal(foreignAfter.hairstyleId, theirs.id);
    assert.equal(foreignAfter.sortOrder, foreign.sortOrder);
  });

  it("removes only the metadata and reports the stored binary as not deleted", async () => {
    const hairstyle = await newHairstyle();
    const keep = await attachImage(hairstyle.id, "keep.jpg");
    const drop = await attachImage(hairstyle.id, "drop.jpg");

    const removed = await removeHairstyleMediaMetadata(drop.id);

    assert.deepEqual(removed, {
      mediaId: drop.id,
      hairstyleId: hairstyle.id,
      storageKey: "drop.jpg",
      externalAssetDeleted: false,
    });
    assert.deepEqual((await listHairstyleMedia(hairstyle.id)).map((m) => m.id), [keep.id]);
    await assertCatalogError(removeHairstyleMediaMetadata(drop.id), "MEDIA_NOT_FOUND");
  });
});
