import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attachHairstyleImage,
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  deactivateCategory,
  getPublicHairstyleBySlug,
  listPublicBookableHairstyles,
  listPublicCategories,
  listPublicHairstyles,
  reorderHairstyleMedia,
} from "@/lib/catalog";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("public catalog visibility", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("shows an active hairstyle in an active category", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    assert.deepEqual((await listPublicCategories()).map((c) => c.slug), ["braids"]);
    assert.deepEqual((await listPublicHairstyles()).map((h) => h.id), [hairstyle.id]);
    assert.equal((await getPublicHairstyleBySlug("knotless"))?.id, hairstyle.id);
  });

  it("hides an inactive hairstyle", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    await createHairstyle({ categoryId: category.id, name: "Hidden", slug: "hidden", isActive: false });

    assert.deepEqual(await listPublicHairstyles(), []);
    assert.equal(await getPublicHairstyleBySlug("hidden"), null);
  });

  it("keeps portfolio visibility separate from bookable priced services", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    await createHairstyle({ categoryId: category.id, name: "Draft", slug: "draft" });
    const simple = await createHairstyle({ categoryId: category.id, name: "Silk Press", slug: "silk-press", priceCents: 18_000 });
    const variants = await createHairstyle({ categoryId: category.id, name: "Bob", slug: "bob", requiresVariant: true });
    const activeVariant = await createHairstyleVariant({ hairstyleId: variants.id, name: "Medium", priceCents: 22_000 });

    const portfolio = await listPublicHairstyles();
    assert.deepEqual(portfolio.map((style) => style.name), ["Draft", "Silk Press", "Bob"]);
    assert.deepEqual(portfolio.map((style) => ({
      name: style.name,
      isBookable: style.isBookable,
      startingPriceCents: style.startingPriceCents,
    })), [
      { name: "Draft", isBookable: false, startingPriceCents: null },
      { name: "Silk Press", isBookable: true, startingPriceCents: 18_000 },
      { name: "Bob", isBookable: true, startingPriceCents: 22_000 },
    ]);
    assert.deepEqual(await listPublicBookableHairstyles(), [
      {
        id: simple.id,
        name: "Silk Press",
        slug: "silk-press",
        description: null,
        category: { id: category.id, name: "Braids", slug: "braids" },
        requiresVariant: false,
        priceCents: 18_000,
        variants: [],
        coverImage: null,
        gallery: [],
      },
      {
        id: variants.id,
        name: "Bob",
        slug: "bob",
        description: null,
        category: { id: category.id, name: "Braids", slug: "braids" },
        requiresVariant: true,
        priceCents: null,
        variants: [{
          id: activeVariant.id,
          name: "Medium",
          description: null,
          priceCents: 22_000,
          coverImage: null,
          gallery: [],
        }],
        coverImage: null,
        gallery: [],
      },
    ]);
  });

  it("an inactive category hides its otherwise-active hairstyles", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });
    await deactivateCategory(category.id);

    assert.deepEqual(await listPublicCategories(), []);
    assert.deepEqual(await listPublicHairstyles(), []);
    assert.deepEqual(await listPublicHairstyles({ categorySlug: "braids" }), []);
    assert.equal(await getPublicHairstyleBySlug("knotless"), null);
  });

  it("filters by category slug and keeps deterministic order", async () => {
    const braids = await createCategory({ name: "Braids", slug: "braids" });
    const twists = await createCategory({ name: "Twists", slug: "twists" });
    const twist = await createHairstyle({ categoryId: twists.id, name: "Senegalese", slug: "senegalese" });
    const a = await createHairstyle({ categoryId: braids.id, name: "A", slug: "a" });
    const b = await createHairstyle({ categoryId: braids.id, name: "B", slug: "b" });

    assert.deepEqual((await listPublicHairstyles()).map((h) => h.id), [a.id, b.id, twist.id]);
    assert.deepEqual((await listPublicHairstyles({ categorySlug: "twists" })).map((h) => h.id), [twist.id]);
  });

  it("public media is ordered, deliverable-only, and never exposes storage keys", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });
    const first = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "k/1.jpg",
      deliveryUrl: "https://cdn.example/k/1.jpg",
    });
    const pending = await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "k/pending.jpg" });
    const second = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "k/2.jpg",
      deliveryUrl: "https://cdn.example/k/2.jpg",
    });

    const detail = await getPublicHairstyleBySlug("knotless");
    assert.deepEqual(detail?.media.map((m) => m.id), [first.id, second.id]);
    assert.ok(detail?.media.every((m) => !("storageKey" in m)));

    const [card] = await listPublicHairstyles();
    assert.equal(card.coverImage?.id, first.id);

    await reorderHairstyleMedia(hairstyle.id, [second.id, first.id, pending.id]);
    const [reorderedCard] = await listPublicHairstyles();
    assert.equal(reorderedCard.coverImage?.id, second.id);
  });

  it("chooses the first ordered delivery URL accepted by the public renderer", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({
      categoryId: category.id,
      name: "Gypsy", slug: "gypsy", priceCents: 20_000,
    });
    await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "legacy/gypsy.jpg",
      deliveryUrl: "https://old-store.public.blob.vercel-storage.com/hairstyles/gypsy/legacy.jpg",
    });
    const valid = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "hairstyles/gypsy/current.jpg",
      deliveryUrl: "https://configured-store.public.blob.vercel-storage.com/hairstyles/gypsy/current.jpg",
    });

    const [style] = await listPublicBookableHairstyles({
      isDeliveryUrlAllowed: (url) => url.startsWith("https://configured-store.public.blob.vercel-storage.com/"),
    });
    assert.equal(style.coverImage?.id, valid.id);
    assert.equal("storageKey" in (style.coverImage ?? {}), false);
  });

  it("delivers active variant galleries independently, with safe service fallback", async () => {
    const origin = "https://configured-store.public.blob.vercel-storage.com/";
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const hairstyle = await createHairstyle({
      categoryId: category.id,
      name: "Gypsy",
      slug: "gypsy",
      requiresVariant: true,
    });
    const ownGalleryVariant = await createHairstyleVariant({
      hairstyleId: hairstyle.id,
      name: "Sleek Braided",
      description: "Soft, polished braids.",
      priceCents: 24_000,
    });
    const fallbackVariant = await createHairstyleVariant({
      hairstyleId: hairstyle.id,
      name: "Gypsy",
      priceCents: 26_000,
    });
    const inactiveVariant = await createHairstyleVariant({
      hairstyleId: hairstyle.id,
      name: "Hidden",
      priceCents: 28_000,
      isActive: false,
    });
    const noPhoto = await createHairstyle({
      categoryId: category.id,
      name: "Silk Press",
      slug: "silk-press",
      priceCents: 18_000,
    });

    await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "service/invalid.jpg",
      deliveryUrl: "https://old-store.public.blob.vercel-storage.com/service/invalid.jpg",
    });
    const serviceCover = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      storageKey: "service/cover.jpg",
      deliveryUrl: `${origin}service/cover.jpg`,
    });
    await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: ownGalleryVariant.id,
      storageKey: "variant/invalid.jpg",
      deliveryUrl: "https://old-store.public.blob.vercel-storage.com/variant/invalid.jpg",
    });
    const ownCover = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: ownGalleryVariant.id,
      storageKey: "variant/cover.jpg",
      deliveryUrl: `${origin}variant/cover.jpg`,
    });
    const ownSecond = await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: ownGalleryVariant.id,
      storageKey: "variant/second.jpg",
      deliveryUrl: `${origin}variant/second.jpg`,
    });
    await attachHairstyleImage({
      hairstyleId: hairstyle.id,
      hairstyleVariantId: inactiveVariant.id,
      storageKey: "inactive/only.jpg",
      deliveryUrl: `${origin}inactive/only.jpg`,
    });

    const styles = await listPublicBookableHairstyles({
      isDeliveryUrlAllowed: (url) => url.startsWith(origin),
    });
    const gypsy = styles.find((style) => style.id === hairstyle.id);
    const noPhotoStyle = styles.find((style) => style.id === noPhoto.id);
    assert.ok(gypsy);
    assert.ok(noPhotoStyle);

    assert.deepEqual(gypsy.gallery.map((image) => image.id), [serviceCover.id]);
    assert.equal(gypsy.coverImage?.id, serviceCover.id);
    assert.deepEqual(gypsy.variants.map((variant) => variant.id), [ownGalleryVariant.id, fallbackVariant.id]);

    const ownGallery = gypsy.variants.find((variant) => variant.id === ownGalleryVariant.id);
    assert.ok(ownGallery);
    assert.equal(ownGallery.description, "Soft, polished braids.");
    assert.equal(ownGallery.priceCents, 24_000);
    assert.deepEqual(ownGallery.gallery.map((image) => image.id), [ownCover.id, ownSecond.id]);
    assert.equal(ownGallery.coverImage?.id, ownCover.id);

    const fallback = gypsy.variants.find((variant) => variant.id === fallbackVariant.id);
    assert.ok(fallback);
    assert.deepEqual(fallback.gallery.map((image) => image.id), [serviceCover.id]);
    assert.equal(fallback.coverImage?.id, serviceCover.id);
    assert.equal(gypsy.variants.some((variant) => variant.id === inactiveVariant.id), false);

    assert.deepEqual(noPhotoStyle.gallery, []);
    assert.equal(noPhotoStyle.coverImage, null);
    assert.ok(gypsy.gallery.every((image) => !("storageKey" in image)));
    assert.ok(ownGallery.gallery.every((image) => !("storageKey" in image)));

    const detail = await getPublicHairstyleBySlug("gypsy", {
      isDeliveryUrlAllowed: (url) => url.startsWith(origin),
    });
    assert.ok(detail);
    assert.equal(detail.isBookable, true);
    assert.equal(detail.startingPriceCents, 24_000);
    assert.deepEqual(detail.gallery.map((image) => image.id), [serviceCover.id]);
    assert.deepEqual(detail.variants.map((variant) => variant.id), [ownGalleryVariant.id, fallbackVariant.id]);
    assert.deepEqual(detail.variants[0]?.gallery.map((image) => image.id), [ownCover.id, ownSecond.id]);
    assert.deepEqual(detail.variants[1]?.gallery.map((image) => image.id), [serviceCover.id]);
    assert.equal(detail.variants.some((variant) => variant.id === inactiveVariant.id), false);
    assert.ok(detail.variants.every((variant) => !("storageKey" in (variant.coverImage ?? {}))));
  });

});
