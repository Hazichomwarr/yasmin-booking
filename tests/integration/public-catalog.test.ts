import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attachHairstyleImage,
  createCategory,
  createHairstyle,
  deactivateCategory,
  getPublicHairstyleBySlug,
  listPublicCategories,
  listPublicHairstyles,
} from "@/lib/catalog";

import { integrationSkip, useCleanTestDatabase } from "../support/catalog-fixtures";

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
    await attachHairstyleImage({ hairstyleId: hairstyle.id, storageKey: "k/pending.jpg" });
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
  });
});
