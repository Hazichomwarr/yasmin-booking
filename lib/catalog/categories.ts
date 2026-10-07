import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import {
  adminCategorySelect,
  categoryOrder,
  type AdminCategory,
} from "./read-shapes";
import {
  assertCompleteOrdering,
  normalizeName,
  normalizeOptionalText,
  normalizeSlug,
} from "./validation";

/**
 * Hairstyle categories (admin operations).
 *
 * Lifecycle: ACTIVE ⇄ INACTIVE. Categories are never hard-deleted through this
 * module — deactivation is how a category leaves public use. Deactivating a
 * category does NOT modify its hairstyles; the public catalog rule
 * (see read-shapes.ts `publiclyVisibleHairstyle`) hides them instead.
 *
 * Ordering: new categories are appended after the current last one.
 * `reorderCategories` is the only way to change sortOrder.
 */

export type CreateCategoryInput = {
  name: string;
  slug: string;
  description?: string | null;
  /** Defaults to true (schema default). */
  isActive?: boolean;
};

export type UpdateCategoryInput = {
  name?: string;
  slug?: string;
  description?: string | null;
};

export async function listCategoriesForAdmin(): Promise<AdminCategory[]> {
  return prisma.hairstyleCategory.findMany({
    select: adminCategorySelect,
    orderBy: categoryOrder,
  });
}

export async function getCategoryForAdmin(categoryId: string): Promise<AdminCategory> {
  const category = await prisma.hairstyleCategory.findUnique({
    where: { id: categoryId },
    select: adminCategorySelect,
  });
  if (!category) throw categoryNotFound(categoryId);
  return category;
}

export async function createCategory(input: CreateCategoryInput): Promise<AdminCategory> {
  const name = normalizeName(input.name, "Category name");
  const slug = normalizeSlug(input.slug);
  const description = normalizeOptionalText(input.description) ?? null;

  const last = await prisma.hairstyleCategory.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (last._max.sortOrder ?? -1) + 1;

  try {
    return await prisma.hairstyleCategory.create({
      data: { name, slug, description, sortOrder, isActive: input.isActive ?? true },
      select: adminCategorySelect,
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "slug")) throw slugTaken(slug);
    throw error;
  }
}

export async function updateCategory(
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<AdminCategory> {
  const data = {
    name: input.name === undefined ? undefined : normalizeName(input.name, "Category name"),
    slug: input.slug === undefined ? undefined : normalizeSlug(input.slug),
    description: normalizeOptionalText(input.description),
  };

  try {
    return await prisma.hairstyleCategory.update({
      where: { id: categoryId },
      data,
      select: adminCategorySelect,
    });
  } catch (error) {
    if (isRecordNotFound(error)) throw categoryNotFound(categoryId);
    if (data.slug && isUniqueViolationOn(error, "slug")) throw slugTaken(data.slug);
    throw error;
  }
}

export function activateCategory(categoryId: string): Promise<AdminCategory> {
  return setCategoryActive(categoryId, true);
}

/**
 * Removes the category — and, through the public catalog rule, all of its
 * hairstyles — from public reads. Child hairstyles keep their own isActive.
 */
export function deactivateCategory(categoryId: string): Promise<AdminCategory> {
  return setCategoryActive(categoryId, false);
}

/**
 * Sets the complete category order. `orderedCategoryIds` must contain every
 * category (active and inactive) exactly once; position i gets sortOrder i.
 */
export async function reorderCategories(
  orderedCategoryIds: string[],
): Promise<AdminCategory[]> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.hairstyleCategory.findMany({
      select: { id: true, sortOrder: true },
    });
    assertCompleteOrdering(
      orderedCategoryIds,
      existing.map((category) => category.id),
      "the category list",
    );

    const currentOrder = new Map(existing.map((c) => [c.id, c.sortOrder]));
    for (const [index, id] of orderedCategoryIds.entries()) {
      if (currentOrder.get(id) === index) continue;
      await tx.hairstyleCategory.update({ where: { id }, data: { sortOrder: index } });
    }
  });

  return listCategoriesForAdmin();
}

async function setCategoryActive(
  categoryId: string,
  isActive: boolean,
): Promise<AdminCategory> {
  try {
    return await prisma.hairstyleCategory.update({
      where: { id: categoryId },
      data: { isActive },
      select: adminCategorySelect,
    });
  } catch (error) {
    if (isRecordNotFound(error)) throw categoryNotFound(categoryId);
    throw error;
  }
}

function categoryNotFound(categoryId: string) {
  return new CatalogError("CATEGORY_NOT_FOUND", `Category ${categoryId} does not exist.`);
}

function slugTaken(slug: string) {
  return new CatalogError(
    "SLUG_ALREADY_EXISTS",
    `Another category already uses the slug "${slug}".`,
  );
}
