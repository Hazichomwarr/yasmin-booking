import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import { adminHairstyleVariantSelect, variantOrder, type AdminHairstyleVariant } from "./read-shapes";
import { assertCompleteOrdering, normalizeName, normalizeOptionalPriceCents } from "./validation";

/** Current catalog configuration only. Appointment snapshots are never edited here. */
export type CreateHairstyleVariantInput = {
  hairstyleId: string;
  name: string;
  priceCents?: number | null;
  isActive?: boolean;
};

export type UpdateHairstyleVariantInput = {
  name?: string;
  priceCents?: number | null;
};

export async function listHairstyleVariantsForAdmin(hairstyleId: string): Promise<AdminHairstyleVariant[]> {
  await assertHairstyleExists(hairstyleId);
  return prisma.hairstyleVariant.findMany({
    where: { hairstyleId },
    select: adminHairstyleVariantSelect,
    orderBy: variantOrder,
  });
}

export async function createHairstyleVariant(input: CreateHairstyleVariantInput): Promise<AdminHairstyleVariant> {
  const name = normalizeName(input.name, "Variant name");
  const priceCents = normalizeOptionalPriceCents(input.priceCents);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockHairstyle(tx, input.hairstyleId);
      const last = await tx.hairstyleVariant.aggregate({ where: { hairstyleId: input.hairstyleId }, _max: { sortOrder: true } });
      return tx.hairstyleVariant.create({
        data: { hairstyleId: input.hairstyleId, name, priceCents, isActive: input.isActive ?? true, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        select: adminHairstyleVariantSelect,
      });
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "hairstyleId_name")) throw new CatalogError("VARIANT_NAME_ALREADY_EXISTS", `Variant ${name} already exists for this hairstyle.`);
    throw error;
  }
}

export async function updateHairstyleVariant(variantId: string, input: UpdateHairstyleVariantInput): Promise<AdminHairstyleVariant> {
  const data = {
    name: input.name === undefined ? undefined : normalizeName(input.name, "Variant name"),
    priceCents: input.priceCents === undefined ? undefined : normalizeOptionalPriceCents(input.priceCents),
  };
  try {
    return await prisma.hairstyleVariant.update({ where: { id: variantId }, data, select: adminHairstyleVariantSelect });
  } catch (error) {
    if (isRecordNotFound(error)) throw variantNotFound(variantId);
    if (isUniqueViolationOn(error, "hairstyleId_name")) throw new CatalogError("VARIANT_NAME_ALREADY_EXISTS", "Another variant already uses that name for this hairstyle.");
    throw error;
  }
}

export async function setHairstyleVariantActive(variantId: string, isActive: boolean): Promise<AdminHairstyleVariant> {
  try {
    return await prisma.hairstyleVariant.update({ where: { id: variantId }, data: { isActive }, select: adminHairstyleVariantSelect });
  } catch (error) {
    if (isRecordNotFound(error)) throw variantNotFound(variantId);
    throw error;
  }
}

export function activateHairstyleVariant(variantId: string) { return setHairstyleVariantActive(variantId, true); }
export function deactivateHairstyleVariant(variantId: string) { return setHairstyleVariantActive(variantId, false); }

export async function reorderHairstyleVariants(hairstyleId: string, orderedVariantIds: string[]): Promise<AdminHairstyleVariant[]> {
  await prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);
    const rows = await tx.hairstyleVariant.findMany({ where: { hairstyleId }, select: { id: true, sortOrder: true } });
    assertCompleteOrdering(orderedVariantIds, rows.map((row) => row.id), `hairstyle ${hairstyleId}`);
    const orders = new Map(rows.map((row) => [row.id, row.sortOrder]));
    for (const [sortOrder, id] of orderedVariantIds.entries()) {
      if (orders.get(id) !== sortOrder) await tx.hairstyleVariant.update({ where: { id }, data: { sortOrder } });
    }
  });
  return listHairstyleVariantsForAdmin(hairstyleId);
}

async function assertHairstyleExists(hairstyleId: string) {
  if (!await prisma.hairstyle.findUnique({ where: { id: hairstyleId }, select: { id: true } })) {
    throw new CatalogError("HAIRSTYLE_NOT_FOUND", `Hairstyle ${hairstyleId} does not exist.`);
  }
}

async function lockHairstyle(tx: Prisma.TransactionClient, hairstyleId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Hairstyle" WHERE "id" = ${hairstyleId} FOR UPDATE`;
  if (rows.length === 0) throw new CatalogError("HAIRSTYLE_NOT_FOUND", `Hairstyle ${hairstyleId} does not exist.`);
}

function variantNotFound(variantId: string) { return new CatalogError("VARIANT_NOT_FOUND", `Hairstyle variant ${variantId} does not exist.`); }
