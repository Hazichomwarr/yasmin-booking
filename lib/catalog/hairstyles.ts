import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import {
  adminHairstyleSelect,
  adminHairstyleVariantSelect,
  adminMediaSelect,
  hairstyleOrder,
  mediaOrder,
  variantOrder,
  toAdminHairstyle,
  type AdminHairstyle,
  type AdminHairstyleDetail,
} from "./read-shapes";
import {
  assertCompleteOrdering,
  normalizeName,
  normalizeOptionalText,
  normalizeOptionalPriceCents,
  normalizeSlug,
} from "./validation";

/**
 * Hairstyles (admin operations).
 *
 * Lifecycle: ACTIVE ⇄ INACTIVE. Hairstyles are never hard-deleted through this
 * module, so Appointment.hairstyleId references always stay valid.
 *
 * History: renaming a hairstyle changes only current catalog configuration.
 * Appointment.hairstyleNameSnapshot belongs to the historical appointment and
 * is never touched by this module.
 *
 * Ordering: hairstyles are ordered within their category. Creating a hairstyle
 * or moving it to another category appends it to the end of that category.
 * `reorderHairstylesInCategory` and `setHairstyleSortOrder` preserve a dense,
 * deterministic order when a curator changes a display position.
 *
 * Concurrency: operations that compute a position inside a category first lock
 * that category row (SELECT ... FOR UPDATE), so concurrent creates/moves/
 * reorders in the same category are serialized rather than racing.
 */

export type CreateHairstyleInput = {
  categoryId: string;
  name: string;
  slug: string;
  description?: string | null;
  /** Defaults to true (schema default). */
  isActive?: boolean;
  /** Null makes a draft/unpriced simple style. */
  priceCents?: number | null;
  requiresVariant?: boolean;
};

export type UpdateHairstyleInput = {
  name?: string;
  slug?: string;
  description?: string | null;
  /** Changing the category appends the hairstyle to the destination's end. */
  categoryId?: string;
  priceCents?: number | null;
  requiresVariant?: boolean;
  /** A style can be active only when its resulting pricing configuration is bookable. */
  isActive?: boolean;
};

export async function listHairstylesForAdmin(
  filter: { categoryId?: string } = {},
): Promise<AdminHairstyle[]> {
  const rows = await prisma.hairstyle.findMany({
    where: { categoryId: filter.categoryId },
    select: adminHairstyleSelect,
    orderBy: hairstyleOrder,
  });
  return rows.map(toAdminHairstyle);
}

export async function getHairstyleDetailForAdmin(
  hairstyleId: string,
): Promise<AdminHairstyleDetail> {
  const row = await prisma.hairstyle.findUnique({
    where: { id: hairstyleId },
    select: {
      ...adminHairstyleSelect,
      media: { select: adminMediaSelect, orderBy: mediaOrder },
      variants: { select: adminHairstyleVariantSelect, orderBy: variantOrder },
    },
  });
  if (!row) throw hairstyleNotFound(hairstyleId);

  const { media, variants, ...hairstyle } = row;
  return { ...toAdminHairstyle(hairstyle), media, variants };
}

export async function createHairstyle(input: CreateHairstyleInput): Promise<AdminHairstyle> {
  const name = normalizeName(input.name, "Hairstyle name");
  const slug = normalizeSlug(input.slug);
  const description = normalizeOptionalText(input.description) ?? null;
  const priceCents = normalizeOptionalPriceCents(input.priceCents);
  const requiresVariant = input.requiresVariant ?? false;
  if (requiresVariant && priceCents !== null) {
    throw new CatalogError("INVALID_PRICE", "A variant-based hairstyle has prices on its variants, not on the hairstyle.");
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const sortOrder = await nextPositionInCategory(tx, input.categoryId);
      return tx.hairstyle.create({
        data: {
          categoryId: input.categoryId,
          name,
          slug,
          description,
          sortOrder,
          isActive: input.isActive ?? true,
          priceCents,
          requiresVariant,
        },
        select: adminHairstyleSelect,
      });
    });
    return toAdminHairstyle(row);
  } catch (error) {
    if (isUniqueViolationOn(error, "slug")) throw slugTaken(slug);
    throw error;
  }
}

export async function updateHairstyle(
  hairstyleId: string,
  input: UpdateHairstyleInput,
): Promise<AdminHairstyle> {
  const data = {
    name: input.name === undefined ? undefined : normalizeName(input.name, "Hairstyle name"),
    slug: input.slug === undefined ? undefined : normalizeSlug(input.slug),
    description: normalizeOptionalText(input.description),
    priceCents: input.priceCents === undefined ? undefined : normalizeOptionalPriceCents(input.priceCents),
    requiresVariant: input.requiresVariant,
    isActive: input.isActive,
  };

  try {
    if (input.categoryId === undefined) {
      if (data.requiresVariant === true && data.priceCents !== undefined && data.priceCents !== null) {
        throw new CatalogError("INVALID_PRICE", "A variant-based hairstyle has prices on its variants, not on the hairstyle.");
      }
      const current = await prisma.hairstyle.findUnique({
        where: { id: hairstyleId },
        select: {
          requiresVariant: true,
          priceCents: true,
          isActive: true,
          variants: { where: { isActive: true, priceCents: { not: null } }, select: { id: true }, take: 1 },
        },
      });
      if (!current) throw hairstyleNotFound(hairstyleId);
      const requiresVariant = data.requiresVariant ?? current.requiresVariant;
      const priceCents = data.priceCents === undefined ? current.priceCents : data.priceCents;
      const isActive = data.isActive ?? current.isActive;
      if (requiresVariant && priceCents !== null) {
        throw new CatalogError("INVALID_PRICE", "A variant-based hairstyle has prices on its variants, not on the hairstyle.");
      }
      if (isActive && ((!requiresVariant && priceCents === null) || (requiresVariant && current.variants.length === 0))) {
        throw new CatalogError("INVALID_PRICE", "A service must have an active price before it can be published.");
      }
      const row = await prisma.hairstyle.update({
        where: { id: hairstyleId },
        data,
        select: adminHairstyleSelect,
      });
      return toAdminHairstyle(row);
    }

    const destinationCategoryId = input.categoryId;
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.hairstyle.findUnique({
        where: { id: hairstyleId },
        select: {
          categoryId: true,
          requiresVariant: true,
          priceCents: true,
          isActive: true,
          variants: { where: { isActive: true, priceCents: { not: null } }, select: { id: true }, take: 1 },
        },
      });
      if (!current) throw hairstyleNotFound(hairstyleId);

      const requiresVariant = data.requiresVariant ?? current.requiresVariant;
      const priceCents = data.priceCents === undefined ? current.priceCents : data.priceCents;
      const isActive = data.isActive ?? current.isActive;
      if (requiresVariant && priceCents !== null) {
        throw new CatalogError("INVALID_PRICE", "A variant-based hairstyle has prices on its variants, not on the hairstyle.");
      }
      if (isActive && ((!requiresVariant && priceCents === null) || (requiresVariant && current.variants.length === 0))) {
        throw new CatalogError("INVALID_PRICE", "A service must have an active price before it can be published.");
      }

      const placement =
        current.categoryId === destinationCategoryId
          ? {}
          : {
              categoryId: destinationCategoryId,
              sortOrder: await nextPositionInCategory(tx, destinationCategoryId),
            };

      return tx.hairstyle.update({
        where: { id: hairstyleId },
        data: { ...data, ...placement },
        select: adminHairstyleSelect,
      });
    });
    return toAdminHairstyle(row);
  } catch (error) {
    if (isRecordNotFound(error)) throw hairstyleNotFound(hairstyleId);
    if (data.slug && isUniqueViolationOn(error, "slug")) throw slugTaken(data.slug);
    throw error;
  }
}

/**
 * Moves a hairstyle to another category, appending it to the end of the
 * destination. Its isActive flag is preserved; if the destination category is
 * inactive the hairstyle simply stops being publicly visible.
 */
export function moveHairstyleToCategory(
  hairstyleId: string,
  destinationCategoryId: string,
): Promise<AdminHairstyle> {
  return updateHairstyle(hairstyleId, { categoryId: destinationCategoryId });
}

export function activateHairstyle(hairstyleId: string): Promise<AdminHairstyle> {
  return setHairstyleActive(hairstyleId, true);
}

/** Hides the hairstyle from public reads. Historical appointments are unaffected. */
export function deactivateHairstyle(hairstyleId: string): Promise<AdminHairstyle> {
  return setHairstyleActive(hairstyleId, false);
}

/**
 * Sets the complete order of hairstyles inside one category.
 * `orderedHairstyleIds` must list every hairstyle currently in the category
 * (active and inactive) exactly once; IDs from another category are rejected.
 */
export async function reorderHairstylesInCategory(
  categoryId: string,
  orderedHairstyleIds: string[],
): Promise<AdminHairstyle[]> {
  await prisma.$transaction(async (tx) => {
    await lockCategory(tx, categoryId);

    const existing = await tx.hairstyle.findMany({
      where: { categoryId },
      select: { id: true, sortOrder: true },
    });
    assertCompleteOrdering(
      orderedHairstyleIds,
      existing.map((hairstyle) => hairstyle.id),
      `category ${categoryId}`,
    );

    const currentOrder = new Map(existing.map((h) => [h.id, h.sortOrder]));
    for (const [index, id] of orderedHairstyleIds.entries()) {
      if (currentOrder.get(id) === index) continue;
      await tx.hairstyle.update({ where: { id }, data: { sortOrder: index } });
    }
  });

  return listHairstylesForAdmin({ categoryId });
}

/**
 * Moves one hairstyle to a zero-based position within its current category.
 * The complete sibling list is rewritten while the category lock is held, so
 * no duplicate or skipped ordering is exposed to concurrent catalog edits.
 */
export async function setHairstyleSortOrder(
  hairstyleId: string,
  requestedSortOrder: number,
): Promise<AdminHairstyle> {
  if (!Number.isSafeInteger(requestedSortOrder) || requestedSortOrder < 0) {
    throw new CatalogError("INVALID_REORDER", "Display order must be a non-negative whole number.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.hairstyle.findUnique({
      where: { id: hairstyleId },
      select: { id: true, categoryId: true },
    });
    if (!current) throw hairstyleNotFound(hairstyleId);

    await lockCategory(tx, current.categoryId);
    const siblings = await tx.hairstyle.findMany({
      where: { categoryId: current.categoryId },
      select: { id: true, sortOrder: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const orderedIds = siblings.map((style) => style.id);
    const currentIndex = orderedIds.indexOf(hairstyleId);
    orderedIds.splice(currentIndex, 1);
    orderedIds.splice(Math.min(requestedSortOrder, orderedIds.length), 0, hairstyleId);

    const previous = new Map(siblings.map((style) => [style.id, style.sortOrder]));
    for (const [sortOrder, id] of orderedIds.entries()) {
      if (previous.get(id) !== sortOrder) {
        await tx.hairstyle.update({ where: { id }, data: { sortOrder } });
      }
    }

    return tx.hairstyle.findUniqueOrThrow({
      where: { id: hairstyleId },
      select: adminHairstyleSelect,
    });
  });
  return toAdminHairstyle(row);
}

async function setHairstyleActive(
  hairstyleId: string,
  isActive: boolean,
): Promise<AdminHairstyle> {
  try {
    if (isActive) {
      const current = await prisma.hairstyle.findUnique({
        where: { id: hairstyleId },
        select: { requiresVariant: true, priceCents: true, variants: { where: { isActive: true, priceCents: { not: null } }, select: { id: true }, take: 1 } },
      });
      if (!current) throw hairstyleNotFound(hairstyleId);
      if ((!current.requiresVariant && current.priceCents === null) || (current.requiresVariant && current.variants.length === 0)) {
        throw new CatalogError("INVALID_PRICE", "A service must have an active price before it can be published.");
      }
    }
    const row = await prisma.hairstyle.update({
      where: { id: hairstyleId },
      data: { isActive },
      select: adminHairstyleSelect,
    });
    return toAdminHairstyle(row);
  } catch (error) {
    if (isRecordNotFound(error)) throw hairstyleNotFound(hairstyleId);
    throw error;
  }
}

/** Locks the category row for the rest of the transaction; throws if missing. */
async function lockCategory(tx: Prisma.TransactionClient, categoryId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "HairstyleCategory" WHERE "id" = ${categoryId} FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new CatalogError("CATEGORY_NOT_FOUND", `Category ${categoryId} does not exist.`);
  }
}

async function nextPositionInCategory(
  tx: Prisma.TransactionClient,
  categoryId: string,
): Promise<number> {
  await lockCategory(tx, categoryId);
  const last = await tx.hairstyle.aggregate({
    where: { categoryId },
    _max: { sortOrder: true },
  });
  return (last._max.sortOrder ?? -1) + 1;
}

function hairstyleNotFound(hairstyleId: string) {
  return new CatalogError("HAIRSTYLE_NOT_FOUND", `Hairstyle ${hairstyleId} does not exist.`);
}

function slugTaken(slug: string) {
  return new CatalogError(
    "SLUG_ALREADY_EXISTS",
    `Another hairstyle already uses the slug "${slug}".`,
  );
}
