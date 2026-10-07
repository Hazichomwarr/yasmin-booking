import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import {
  adminHairstyleSelect,
  adminMediaSelect,
  hairstyleOrder,
  mediaOrder,
  toAdminHairstyle,
  type AdminHairstyle,
  type AdminHairstyleDetail,
} from "./read-shapes";
import {
  assertCompleteOrdering,
  normalizeName,
  normalizeOptionalText,
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
 * `reorderHairstylesInCategory` is the only way to change sortOrder.
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
};

export type UpdateHairstyleInput = {
  name?: string;
  slug?: string;
  description?: string | null;
  /** Changing the category appends the hairstyle to the destination's end. */
  categoryId?: string;
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
    },
  });
  if (!row) throw hairstyleNotFound(hairstyleId);

  const { media, ...hairstyle } = row;
  return { ...toAdminHairstyle(hairstyle), media };
}

export async function createHairstyle(input: CreateHairstyleInput): Promise<AdminHairstyle> {
  const name = normalizeName(input.name, "Hairstyle name");
  const slug = normalizeSlug(input.slug);
  const description = normalizeOptionalText(input.description) ?? null;

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
  };

  try {
    if (input.categoryId === undefined) {
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
        select: { categoryId: true },
      });
      if (!current) throw hairstyleNotFound(hairstyleId);

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

async function setHairstyleActive(
  hairstyleId: string,
  isActive: boolean,
): Promise<AdminHairstyle> {
  try {
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
