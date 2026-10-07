import { prisma } from "@/lib/prisma";

import {
  categoryOrder,
  hairstyleOrder,
  mediaOrder,
  publicCategorySelect,
  publiclyDeliverableMedia,
  publiclyVisibleHairstyle,
  publicMediaSelect,
  toPublicMedia,
  type PublicCategory,
  type PublicHairstyle,
  type PublicHairstyleDetail,
} from "./read-shapes";

/**
 * Public catalog reads — the ONLY reads public pages should use.
 *
 * Every hairstyle read here applies `publiclyVisibleHairstyle`:
 *   Hairstyle.isActive = true AND HairstyleCategory.isActive = true
 * Media is limited to rows with a deliveryUrl and never exposes storage keys.
 * Records that are not publicly visible are indistinguishable from missing
 * ones (detail reads return null).
 */

export async function listPublicCategories(): Promise<PublicCategory[]> {
  return prisma.hairstyleCategory.findMany({
    where: { isActive: true },
    select: publicCategorySelect,
    orderBy: categoryOrder,
  });
}

export async function listPublicHairstyles(
  filter: { categorySlug?: string } = {},
): Promise<PublicHairstyle[]> {
  const rows = await prisma.hairstyle.findMany({
    where: {
      ...publiclyVisibleHairstyle,
      category: { ...publiclyVisibleHairstyle.category, slug: filter.categorySlug },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      category: { select: { name: true, slug: true } },
      media: {
        where: { ...publiclyDeliverableMedia, type: "IMAGE" },
        select: publicMediaSelect,
        orderBy: mediaOrder,
        take: 1,
      },
    },
    orderBy: hairstyleOrder,
  });

  return rows.map(({ media, ...hairstyle }) => ({
    ...hairstyle,
    coverImage: media[0] ? toPublicMedia(media[0]) : null,
  }));
}

export async function getPublicHairstyleBySlug(
  slug: string,
): Promise<PublicHairstyleDetail | null> {
  const row = await prisma.hairstyle.findFirst({
    where: { ...publiclyVisibleHairstyle, slug: slug.trim().toLowerCase() },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      category: { select: { name: true, slug: true } },
      media: {
        where: publiclyDeliverableMedia,
        select: publicMediaSelect,
        orderBy: mediaOrder,
      },
    },
  });
  if (!row) return null;

  return { ...row, media: row.media.map(toPublicMedia) };
}
