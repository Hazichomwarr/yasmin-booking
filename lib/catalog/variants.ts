import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import { adminHairstyleVariantSelect, variantOrder, type AdminHairstyleVariant } from "./read-shapes";
import {
  assertCompleteOrdering,
  normalizeName,
  normalizeOptionalPriceCents,
  normalizeOptionalVariantDescription,
} from "./validation";

/** Current catalog configuration only. Appointment snapshots are never edited here. */
export type CreateHairstyleVariantInput = {
  hairstyleId: string;
  name: string;
  description?: string | null;
  priceCents?: number | null;
  isActive?: boolean;
};

export type UpdateHairstyleVariantInput = {
  name?: string;
  description?: string | null;
  priceCents?: number | null;
  isActive?: boolean;
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
  const description = normalizeOptionalVariantDescription(input.description) ?? null;
  const priceCents = normalizeOptionalPriceCents(input.priceCents);
  const isActive = input.isActive ?? true;
  assertActiveVariantPrice(priceCents, isActive);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockHairstyle(tx, input.hairstyleId);
      const last = await tx.hairstyleVariant.aggregate({ where: { hairstyleId: input.hairstyleId }, _max: { sortOrder: true } });
      return tx.hairstyleVariant.create({
        data: { hairstyleId: input.hairstyleId, name, description, priceCents, isActive, sortOrder: (last._max.sortOrder ?? -1) + 1 },
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
    description: normalizeOptionalVariantDescription(input.description),
    priceCents: input.priceCents === undefined ? undefined : normalizeOptionalPriceCents(input.priceCents),
    isActive: input.isActive,
  };
  try {
    const current = await prisma.hairstyleVariant.findUnique({
      where: { id: variantId },
      select: {
        hairstyleId: true,
        priceCents: true,
        isActive: true,
        hairstyle: { select: { isActive: true, requiresVariant: true } },
      },
    });
    if (!current) throw variantNotFound(variantId);
    const nextPriceCents = data.priceCents === undefined ? current.priceCents : data.priceCents;
    const nextIsActive = data.isActive ?? current.isActive;
    assertActiveVariantPrice(nextPriceCents, nextIsActive);
    if (current.hairstyle.isActive && current.hairstyle.requiresVariant && current.isActive && !nextIsActive) {
      const otherActiveCount = await prisma.hairstyleVariant.count({
        where: { hairstyleId: current.hairstyleId, id: { not: variantId }, isActive: true, priceCents: { not: null } },
      });
      if (otherActiveCount === 0) {
        throw new CatalogError("INVALID_PRICE", "Deactivate the service before removing its last active priced variant.");
      }
    }
    return await prisma.hairstyleVariant.update({ where: { id: variantId }, data, select: adminHairstyleVariantSelect });
  } catch (error) {
    if (isRecordNotFound(error)) throw variantNotFound(variantId);
    if (isUniqueViolationOn(error, "hairstyleId_name")) throw new CatalogError("VARIANT_NAME_ALREADY_EXISTS", "Another variant already uses that name for this hairstyle.");
    throw error;
  }
}

export async function setHairstyleVariantActive(variantId: string, isActive: boolean): Promise<AdminHairstyleVariant> {
  return updateHairstyleVariant(variantId, { isActive });
}

export function activateHairstyleVariant(variantId: string) { return setHairstyleVariantActive(variantId, true); }
export function deactivateHairstyleVariant(variantId: string) { return setHairstyleVariantActive(variantId, false); }

/**
 * Ensures a route scoped to one hairstyle cannot mutate a variant belonging
 * to another hairstyle.
 */
export async function updateHairstyleVariantForHairstyle(
  hairstyleId: string,
  variantId: string,
  input: UpdateHairstyleVariantInput,
): Promise<AdminHairstyleVariant> {
  const variant = await prisma.hairstyleVariant.findFirst({
    where: { id: variantId, hairstyleId },
    select: { id: true },
  });
  if (!variant) throw variantNotFound(variantId);
  return updateHairstyleVariant(variantId, input);
}

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

function assertActiveVariantPrice(priceCents: number | null, isActive: boolean) {
  if (isActive && (priceCents === null || priceCents < 4_000)) {
    throw new CatalogError("INVALID_PRICE", "An active variant needs a price of at least $40.00.");
  }
}
