import type { Prisma } from "@prisma/client";

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
  type PublicMedia,
} from "./read-shapes";

type CoverImageOptions = {
  /** Presentation callers can require their configured Blob origin. */
  isDeliveryUrlAllowed?: (deliveryUrl: string) => boolean;
};

const publicMediaWithOwnershipSelect = {
  ...publicMediaSelect,
  hairstyleVariantId: true,
} satisfies Prisma.HairstyleMediaSelect;

type PublicMediaWithOwnership = Prisma.HairstyleMediaGetPayload<{
  select: typeof publicMediaWithOwnershipSelect;
}>;

function publicImagesFrom(
  media: Array<Parameters<typeof toPublicMedia>[0]>,
  options: CoverImageOptions,
): PublicMedia[] {
  return media
    .map(toPublicMedia)
    .filter((item) => options.isDeliveryUrlAllowed?.(item.deliveryUrl) ?? true);
}

function galleryFor(
  media: PublicMediaWithOwnership[],
  hairstyleVariantId: string | null,
  options: CoverImageOptions,
): PublicMedia[] {
  return publicImagesFrom(
    media.filter((item) => item.hairstyleVariantId === hairstyleVariantId),
    options,
  );
}

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
  options: CoverImageOptions = {},
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
        take: 8,
      },
    },
    orderBy: hairstyleOrder,
  });

  return rows.map(({ media, ...hairstyle }) => {
    const gallery = publicImagesFrom(media, options);
    return { ...hairstyle, coverImage: gallery[0] ?? null, gallery };
  });
}

/**
 * Public booking choices are intentionally narrower than the portfolio.
 * An active portfolio style can remain visible while it is not presently
 * sellable (for example, a draft price or no active priced variant).
 */
export type PublicBookableHairstyle = {
  id: string;
  name: string;
  description: string | null;
  category: { id: string; name: string; slug: string };
  requiresVariant: boolean;
  priceCents: number | null;
  variants: Array<{
    id: string;
    name: string;
    description: string | null;
    priceCents: number;
    /** The variant gallery, or the service gallery when it has no valid photos. */
    gallery: PublicMedia[];
    coverImage: PublicMedia | null;
  }>;
  /** Ordered service-gallery images only; variant galleries remain independent. */
  gallery: PublicMedia[];
  coverImage: PublicMedia | null;
};

/**
 * The customer booking selector's safe catalog contract. Prices are display
 * data only; createPublicBooking resolves and snapshots them again under its
 * transaction before it creates a hold.
 */
export async function listPublicBookableHairstyles(
  options: CoverImageOptions = {},
): Promise<PublicBookableHairstyle[]> {
  const rows = await prisma.hairstyle.findMany({
    where: {
      ...publiclyVisibleHairstyle,
      OR: [
        { requiresVariant: false, priceCents: { gte: 4_000 } },
        { requiresVariant: true, variants: { some: { isActive: true, priceCents: { gte: 4_000 } } } },
      ],
    },
    select: {
      id: true,
      name: true,
      description: true,
      requiresVariant: true,
      priceCents: true,
      category: { select: { id: true, name: true, slug: true } },
      variants: {
        where: { isActive: true, priceCents: { gte: 4_000 } },
        select: { id: true, name: true, description: true, priceCents: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      },
      media: {
        where: {
          deliveryUrl: { not: null },
          type: "IMAGE",
          OR: [
            { hairstyleVariantId: null },
            { hairstyleVariant: { isActive: true, priceCents: { gte: 4_000 } } },
          ],
        },
        select: publicMediaWithOwnershipSelect,
        orderBy: mediaOrder,
      },
    },
    orderBy: hairstyleOrder,
  });

  return rows.map(({ media, variants, ...hairstyle }) => {
    const gallery = galleryFor(media, null, options);
    return {
      ...hairstyle,
      variants: variants.map((variant) => {
        const variantGallery = galleryFor(media, variant.id, options);
        const effectiveGallery = variantGallery.length > 0 ? variantGallery : gallery;
        return {
          ...variant,
          priceCents: variant.priceCents as number,
          gallery: effectiveGallery,
          coverImage: effectiveGallery[0] ?? null,
        };
      }),
      gallery,
      coverImage: gallery[0] ?? null,
    };
  });
}

export async function getPublicHairstyleBySlug(
  slug: string,
  options: CoverImageOptions = {},
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

  return { ...row, media: publicImagesFrom(row.media, options) };
}
