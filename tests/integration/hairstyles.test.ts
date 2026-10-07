import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activateHairstyle,
  createCategory,
  createHairstyle,
  deactivateCategory,
  deactivateHairstyle,
  getHairstyleDetailForAdmin,
  listHairstylesForAdmin,
  moveHairstyleToCategory,
  reorderHairstylesInCategory,
  updateHairstyle,
} from "@/lib/catalog";
import { prisma } from "@/lib/prisma";

import { assertCatalogError } from "../support/assertions";
import {
  createHistoricalAppointment,
  integrationSkip,
  useCleanTestDatabase,
} from "../support/catalog-fixtures";

describe("catalog hairstyles", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  async function braidsCategory() {
    return createCategory({ name: "Braids", slug: "braids" });
  }

  it("creates a hairstyle with normalized fields, appended within its category", async () => {
    const category = await braidsCategory();
    const first = await createHairstyle({
      categoryId: category.id,
      name: "  Knotless   Braids ",
      slug: "Knotless-Braids",
      description: " Lightweight ",
    });
    const second = await createHairstyle({ categoryId: category.id, name: "Fulani", slug: "fulani" });

    assert.equal(first.name, "Knotless Braids");
    assert.equal(first.slug, "knotless-braids");
    assert.equal(first.description, "Lightweight");
    assert.equal(first.category.id, category.id);
    assert.equal(first.isPubliclyVisible, true);
    assert.ok(second.sortOrder > first.sortOrder);
  });

  it("rejects a missing category", async () => {
    await assertCatalogError(
      createHairstyle({ categoryId: "missing-category", name: "Knotless", slug: "knotless" }),
      "CATEGORY_NOT_FOUND",
    );
  });

  it("rejects blank name and blank slug", async () => {
    const category = await braidsCategory();
    await assertCatalogError(createHairstyle({ categoryId: category.id, name: " ", slug: "x" }), "INVALID_NAME");
    await assertCatalogError(createHairstyle({ categoryId: category.id, name: "X", slug: " " }), "INVALID_SLUG");
  });

  it("reports a duplicate slug as a domain error", async () => {
    const category = await braidsCategory();
    await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });
    const other = await createHairstyle({ categoryId: category.id, name: "Fulani", slug: "fulani" });

    await assertCatalogError(
      createHairstyle({ categoryId: category.id, name: "Copy", slug: "knotless" }),
      "SLUG_ALREADY_EXISTS",
    );
    await assertCatalogError(updateHairstyle(other.id, { slug: "knotless" }), "SLUG_ALREADY_EXISTS");
  });

  it("updates editable fields", async () => {
    const category = await braidsCategory();
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    const updated = await updateHairstyle(hairstyle.id, {
      name: "Small Knotless",
      slug: "small-knotless",
      description: "Waist length",
    });
    assert.equal(updated.name, "Small Knotless");
    assert.equal(updated.slug, "small-knotless");
    assert.equal(updated.description, "Waist length");

    await assertCatalogError(updateHairstyle("missing-id", { name: "X" }), "HAIRSTYLE_NOT_FOUND");
  });

  it("moves a hairstyle to the end of another category, preserving its active flag", async () => {
    const braids = await braidsCategory();
    const twists = await createCategory({ name: "Twists", slug: "twists" });
    const existingTwist = await createHairstyle({ categoryId: twists.id, name: "Senegalese", slug: "senegalese" });
    const hairstyle = await createHairstyle({
      categoryId: braids.id,
      name: "Passion",
      slug: "passion",
      isActive: false,
    });

    const moved = await moveHairstyleToCategory(hairstyle.id, twists.id);

    assert.equal(moved.category.id, twists.id);
    assert.equal(moved.isActive, false);
    assert.ok(moved.sortOrder > existingTwist.sortOrder);
    assert.deepEqual(
      (await listHairstylesForAdmin({ categoryId: twists.id })).map((h) => h.id),
      [existingTwist.id, hairstyle.id],
    );
  });

  it("rejects moving to a missing category or moving a missing hairstyle", async () => {
    const category = await braidsCategory();
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    await assertCatalogError(moveHairstyleToCategory(hairstyle.id, "missing-category"), "CATEGORY_NOT_FOUND");
    await assertCatalogError(moveHairstyleToCategory("missing-id", category.id), "HAIRSTYLE_NOT_FOUND");
    assert.equal((await getHairstyleDetailForAdmin(hairstyle.id)).category.id, category.id);
  });

  it("activates and deactivates", async () => {
    const category = await braidsCategory();
    const hairstyle = await createHairstyle({ categoryId: category.id, name: "Knotless", slug: "knotless" });

    const deactivated = await deactivateHairstyle(hairstyle.id);
    assert.equal(deactivated.isActive, false);
    assert.equal(deactivated.isPubliclyVisible, false);
    assert.equal((await activateHairstyle(hairstyle.id)).isActive, true);
    await assertCatalogError(activateHairstyle("missing-id"), "HAIRSTYLE_NOT_FOUND");
  });

  it("lists hairstyles (including inactive) grouped by category order, then their own order", async () => {
    const braids = await braidsCategory();
    const twists = await createCategory({ name: "Twists", slug: "twists" });
    const twist = await createHairstyle({ categoryId: twists.id, name: "Senegalese", slug: "senegalese" });
    const knotless = await createHairstyle({ categoryId: braids.id, name: "Knotless", slug: "knotless" });
    const fulani = await createHairstyle({
      categoryId: braids.id,
      name: "Fulani",
      slug: "fulani",
      isActive: false,
    });

    const ids = (await listHairstylesForAdmin()).map((h) => h.id);
    assert.deepEqual(ids, [knotless.id, fulani.id, twist.id]);
  });

  it("reorders hairstyles within a category", async () => {
    const category = await braidsCategory();
    const a = await createHairstyle({ categoryId: category.id, name: "A", slug: "a" });
    const b = await createHairstyle({ categoryId: category.id, name: "B", slug: "b" });
    const c = await createHairstyle({ categoryId: category.id, name: "C", slug: "c", isActive: false });

    const result = await reorderHairstylesInCategory(category.id, [b.id, c.id, a.id]);
    assert.deepEqual(result.map((h) => h.id), [b.id, c.id, a.id]);
  });

  it("rejects a reorder that includes a hairstyle from another category", async () => {
    const braids = await braidsCategory();
    const twists = await createCategory({ name: "Twists", slug: "twists" });
    const a = await createHairstyle({ categoryId: braids.id, name: "A", slug: "a" });
    const b = await createHairstyle({ categoryId: braids.id, name: "B", slug: "b" });
    const foreign = await createHairstyle({ categoryId: twists.id, name: "T", slug: "t" });

    await assertCatalogError(
      reorderHairstylesInCategory(braids.id, [b.id, foreign.id, a.id]),
      "INVALID_REORDER",
    );
    await assertCatalogError(reorderHairstylesInCategory("missing-category", []), "CATEGORY_NOT_FOUND");

    const foreignAfter = await prisma.hairstyle.findUniqueOrThrow({ where: { id: foreign.id } });
    assert.equal(foreignAfter.categoryId, twists.id);
    assert.equal(foreignAfter.sortOrder, foreign.sortOrder);
    assert.deepEqual(
      (await listHairstylesForAdmin({ categoryId: braids.id })).map((h) => h.id),
      [a.id, b.id],
    );
  });
});

describe("catalog changes preserve appointment history", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("rename, move, and deactivation never rewrite an appointment's snapshot", async () => {
    const braids = await createCategory({ name: "Braids", slug: "braids" });
    const twists = await createCategory({ name: "Twists", slug: "twists" });
    const hairstyle = await createHairstyle({ categoryId: braids.id, name: "Knotless", slug: "knotless" });
    const appointment = await createHistoricalAppointment(hairstyle.id, "Knotless");

    await updateHairstyle(hairstyle.id, { name: "Small Knotless (2027)", slug: "small-knotless" });
    await moveHairstyleToCategory(hairstyle.id, twists.id);
    await deactivateHairstyle(hairstyle.id);
    await deactivateCategory(twists.id);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    assert.equal(after.hairstyleNameSnapshot, "Knotless");
    assert.equal(after.hairstyleId, hairstyle.id);
    assert.equal(after.totalPriceCents, appointment.totalPriceCents);
    assert.deepEqual(after.updatedAt, appointment.updatedAt);
  });
});
