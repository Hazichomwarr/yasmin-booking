import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activateCategory,
  createCategory,
  createHairstyle,
  deactivateCategory,
  listCategoriesForAdmin,
  reorderCategories,
  updateCategory,
} from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { assertCatalogError } from "../support/assertions";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("catalog categories", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("creates a category with normalized fields, appended to the end", async () => {
    const first = await createCategory({ name: " Braids ", slug: " Braids ", description: "  " });
    const second = await createCategory({ name: "Locs", slug: "locs", description: " Starter & retwist " });

    assert.equal(first.name, "Braids");
    assert.equal(first.slug, "braids");
    assert.equal(first.description, null);
    assert.equal(first.isActive, true);
    assert.equal(second.description, "Starter & retwist");
    assert.ok(second.sortOrder > first.sortOrder);
  });

  it("rejects blank name and blank slug", async () => {
    await assertCatalogError(createCategory({ name: "  ", slug: "braids" }), "INVALID_NAME");
    await assertCatalogError(createCategory({ name: "Braids", slug: "  " }), "INVALID_SLUG");
    assert.equal(await prisma.hairstyleCategory.count(), 0);
  });

  it("reports a duplicate slug as a domain error without overwriting the original", async () => {
    const original = await createCategory({ name: "Braids", slug: "braids" });
    await assertCatalogError(createCategory({ name: "Other", slug: "BRAIDS" }), "SLUG_ALREADY_EXISTS");

    const other = await createCategory({ name: "Twists", slug: "twists" });
    await assertCatalogError(updateCategory(other.id, { slug: "braids" }), "SLUG_ALREADY_EXISTS");

    const stored = await prisma.hairstyleCategory.findUniqueOrThrow({ where: { slug: "braids" } });
    assert.equal(stored.id, original.id);
    assert.equal(stored.name, "Braids");
  });

  it("updates editable fields and leaves omitted fields unchanged", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids", description: "Classic" });

    const renamed = await updateCategory(category.id, { name: "  Box Braids ", slug: "box-braids" });
    assert.equal(renamed.name, "Box Braids");
    assert.equal(renamed.slug, "box-braids");
    assert.equal(renamed.description, "Classic");

    const cleared = await updateCategory(category.id, { description: null });
    assert.equal(cleared.description, null);

    await assertCatalogError(updateCategory("missing-id", { name: "X" }), "CATEGORY_NOT_FOUND");
  });

  it("activates and deactivates", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });

    assert.equal((await deactivateCategory(category.id)).isActive, false);
    assert.equal((await activateCategory(category.id)).isActive, true);
    await assertCatalogError(deactivateCategory("missing-id"), "CATEGORY_NOT_FOUND");
  });

  it("deactivation does not rewrite child hairstyle isActive flags", async () => {
    const category = await createCategory({ name: "Braids", slug: "braids" });
    const active = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });
    const inactive = await createHairstyle({
      categoryId: category.id,
      name: "Fulani",
      slug: "fulani",
      isActive: false,
    });

    await deactivateCategory(category.id);
    await activateCategory(category.id);

    const children = await prisma.hairstyle.findMany({ select: { id: true, isActive: true } });
    const flags = new Map(children.map((h) => [h.id, h.isActive]));
    assert.equal(flags.get(active.id), true);
    assert.equal(flags.get(inactive.id), false);
  });

  it("lists all categories (including inactive) in deterministic order", async () => {
    const a = await createCategory({ name: "A", slug: "a" });
    const b = await createCategory({ name: "B", slug: "b", isActive: false });
    // Same sortOrder as `a`: tie broken by createdAt, then id.
    const tied = await prisma.hairstyleCategory.create({
      data: { name: "Tied", slug: "tied", sortOrder: a.sortOrder },
    });

    const ids = (await listCategoriesForAdmin()).map((c) => c.id);
    assert.deepEqual(ids, [a.id, tied.id, b.id]);
    assert.deepEqual((await listCategoriesForAdmin()).map((c) => c.id), ids);
  });

  it("reorders all categories from an ordered ID list", async () => {
    const a = await createCategory({ name: "A", slug: "a" });
    const b = await createCategory({ name: "B", slug: "b" });
    const c = await createCategory({ name: "C", slug: "c", isActive: false });

    const result = await reorderCategories([c.id, a.id, b.id]);

    assert.deepEqual(result.map((x) => x.id), [c.id, a.id, b.id]);
    assert.deepEqual(result.map((x) => x.sortOrder), [0, 1, 2]);
  });

  it("rejects an invalid reorder and leaves the order untouched", async () => {
    const a = await createCategory({ name: "A", slug: "a" });
    const b = await createCategory({ name: "B", slug: "b" });
    const before = await listCategoriesForAdmin();

    await assertCatalogError(reorderCategories([b.id]), "INVALID_REORDER");
    await assertCatalogError(reorderCategories([b.id, a.id, "unknown"]), "INVALID_REORDER");
    await assertCatalogError(reorderCategories([b.id, b.id]), "INVALID_REORDER");

    assert.deepEqual(await listCategoriesForAdmin(), before);
  });
});
