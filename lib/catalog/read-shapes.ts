import type { MediaType, Prisma } from "@prisma/client";

/**
 * Explicit read shapes returned by catalog services, plus the shared ordering
 * and visibility rules used to produce them.
 */

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Every catalog list is ordered by sortOrder, then createdAt, then id.
 * The id tie-breaker makes ordering fully deterministic even if two records
 * share a sortOrder and timestamp.
 */
export const categoryOrder = [
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.HairstyleCategoryOrderByWithRelationInput[];

/** Hairstyles group by their category's order first, then their own order. */
export const hairstyleOrder = [
  { category: { sortOrder: "asc" } },
  { category: { createdAt: "asc" } },
  { categoryId: "asc" },
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.HairstyleOrderByWithRelationInput[];

export const mediaOrder = [
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.HairstyleMediaOrderByWithRelationInput[];

// ---------------------------------------------------------------------------
// Public visibility
// ---------------------------------------------------------------------------

/**
 * THE public catalog rule. A hairstyle is publicly visible only when:
 *   Hairstyle.isActive = true AND its HairstyleCategory.isActive = true
 *
 * Deactivating a category therefore hides all of its hairstyles without
 * touching their own isActive flags, and reactivating it restores exactly the
 * hairstyles that were individually active.
 *
 * Every public read goes through this filter; UI code never has to remember it.
 */
export const publiclyVisibleHairstyle = {
  isActive: true,
  category: { isActive: true },
} satisfies Prisma.HairstyleWhereInput;

export function isPubliclyVisible(hairstyle: {
  isActive: boolean;
  category: { isActive: boolean };
}): boolean {
  return hairstyle.isActive && hairstyle.category.isActive;
}

/** Public media must have somewhere to be delivered from. */
export const publiclyDeliverableMedia = {
  deliveryUrl: { not: null },
} satisfies Prisma.HairstyleMediaWhereInput;

// ---------------------------------------------------------------------------
// Admin shapes (include inactive records and internal fields)
// ---------------------------------------------------------------------------

export type AdminCategory = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminMedia = {
  id: string;
  hairstyleId: string;
  type: MediaType;
  storageKey: string;
  deliveryUrl: string | null;
  altText: string | null;
  caption: string | null;
  sortOrder: number;
  createdAt: Date;
};

export type AdminHairstyle = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  category: { id: string; name: string; slug: string; isActive: boolean };
  /** Derived from the public catalog rule — useful for admin badges. */
  isPubliclyVisible: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminHairstyleDetail = AdminHairstyle & { media: AdminMedia[] };

export const adminCategorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HairstyleCategorySelect;

export const adminMediaSelect = {
  id: true,
  hairstyleId: true,
  type: true,
  storageKey: true,
  deliveryUrl: true,
  altText: true,
  caption: true,
  sortOrder: true,
  createdAt: true,
} satisfies Prisma.HairstyleMediaSelect;

export const adminHairstyleSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, slug: true, isActive: true } },
} satisfies Prisma.HairstyleSelect;

type AdminHairstyleRow = Prisma.HairstyleGetPayload<{
  select: typeof adminHairstyleSelect;
}>;

export function toAdminHairstyle(row: AdminHairstyleRow): AdminHairstyle {
  return { ...row, isPubliclyVisible: isPubliclyVisible(row) };
}

// ---------------------------------------------------------------------------
// Public shapes (no activation flags, no storage keys)
// ---------------------------------------------------------------------------

export type PublicCategory = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export type PublicMedia = {
  id: string;
  type: MediaType;
  deliveryUrl: string;
  altText: string | null;
  caption: string | null;
};

export type PublicHairstyle = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: { name: string; slug: string };
  /** First deliverable IMAGE in media order, for catalog cards. */
  coverImage: PublicMedia | null;
};

export type PublicHairstyleDetail = Omit<PublicHairstyle, "coverImage"> & {
  media: PublicMedia[];
};

export const publicCategorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
} satisfies Prisma.HairstyleCategorySelect;

export const publicMediaSelect = {
  id: true,
  type: true,
  deliveryUrl: true,
  altText: true,
  caption: true,
} satisfies Prisma.HairstyleMediaSelect;

type PublicMediaRow = Prisma.HairstyleMediaGetPayload<{
  select: typeof publicMediaSelect;
}>;

export function toPublicMedia(row: PublicMediaRow): PublicMedia {
  // Rows are pre-filtered with publiclyDeliverableMedia; this guards the type.
  if (row.deliveryUrl === null) {
    throw new Error(`Media ${row.id} has no delivery URL but reached a public read.`);
  }
  return { ...row, deliveryUrl: row.deliveryUrl };
}
