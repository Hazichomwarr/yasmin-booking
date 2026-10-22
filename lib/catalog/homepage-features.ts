import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";
import { prisma } from "@/lib/prisma";

import type { PublicMedia } from "./read-shapes";

export const MAX_HOMEPAGE_FEATURES = 4;
const MINIMUM_BOOKABLE_PRICE_CENTS = 4_000;
const HOMEPAGE_FEATURE_LOCK_KEY = 4_502_022;

export type HomepageFeatureTarget = {
  hairstyleId: string;
  hairstyleVariantId: string | null;
};

export type AdminHomepageFeatureOption = HomepageFeatureTarget & {
  key: string;
  hairstyleName: string;
  variantName: string | null;
  categoryName: string;
  label: string;
  coverImage: PublicMedia | null;
  publicStatus: "available" | "portfolio-only" | "unavailable";
  statusMessage: string;
};

export type AdminHomepageFeatureState = {
  revision: string;
  features: AdminHomepageFeatureOption[];
  options: AdminHomepageFeatureOption[];
};

export type PublicHomepageFeature = {
  id: string;
  name: string;
  serviceName: string;
  variantName: string | null;
  priceCents: number | null;
  coverImage: PublicMedia | null;
  href: string;
};

export class HomepageFeatureError extends Error {
  constructor(
    readonly code:
      | "INVALID_FEATURES"
      | "FEATURE_LIMIT_EXCEEDED"
      | "DUPLICATE_FEATURE"
      | "FEATURE_TARGET_NOT_FOUND"
      | "VARIANT_OWNERSHIP_MISMATCH"
      | "STALE_FEATURE_CONFIGURATION",
  ) {
    super(code);
    this.name = "HomepageFeatureError";
  }
}

function targetKey(target: HomepageFeatureTarget): string {
  return target.hairstyleVariantId
    ? `variant:${target.hairstyleVariantId}`
    : `service:${target.hairstyleId}`;
}

function revisionFor(rows: Array<{
  id: string;
  hairstyleId: string;
  hairstyleVariantId: string | null;
  sortOrder: number;
  updatedAt: Date;
}>): string {
  const canonical = rows
    .map((row) => [row.id, row.hairstyleId, row.hairstyleVariantId, row.sortOrder, row.updatedAt.toISOString()])
    .sort((left, right) => Number(left[3]) - Number(right[3]) || String(left[0]).localeCompare(String(right[0])));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function approvedMedia<T extends { deliveryUrl: string | null; id: string; type: "IMAGE" | "VIDEO"; altText: string | null; caption: string | null; sortOrder: number }>(
  rows: T[],
): PublicMedia[] {
  return rows
    .filter((row): row is T & { deliveryUrl: string } => isApprovedBlobDeliveryUrl(row.deliveryUrl, process.env.BLOB_PUBLIC_BASE_URL))
    .map(({ id, type, deliveryUrl, altText, caption, sortOrder }) => ({ id, type, deliveryUrl, altText, caption, sortOrder }));
}

const featureCatalogSelect = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  requiresVariant: true,
  priceCents: true,
  sortOrder: true,
  category: { select: { name: true, isActive: true, sortOrder: true } },
  variants: {
    select: { id: true, name: true, isActive: true, priceCents: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  },
  media: {
    where: { type: "IMAGE", deliveryUrl: { not: null } },
    select: {
      id: true,
      type: true,
      hairstyleVariantId: true,
      deliveryUrl: true,
      altText: true,
      caption: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.HairstyleSelect;

type FeatureCatalogRow = Prisma.HairstyleGetPayload<{ select: typeof featureCatalogSelect }>;

function serviceStartingPrice(row: FeatureCatalogRow): number | null {
  if (!row.requiresVariant) {
    return row.priceCents !== null && row.priceCents >= MINIMUM_BOOKABLE_PRICE_CENTS ? row.priceCents : null;
  }
  return row.variants.reduce<number | null>((lowest, variant) => {
    if (!variant.isActive || variant.priceCents === null || variant.priceCents < MINIMUM_BOOKABLE_PRICE_CENTS) return lowest;
    return lowest === null || variant.priceCents < lowest ? variant.priceCents : lowest;
  }, null);
}

function optionFor(row: FeatureCatalogRow, variantId: string | null): AdminHomepageFeatureOption | null {
  const serviceGallery = approvedMedia(row.media.filter((media) => media.hairstyleVariantId === null));
  const variant = variantId === null ? null : row.variants.find((candidate) => candidate.id === variantId);
  if (variantId !== null && !variant) return null;
  const variantGallery = variant ? approvedMedia(row.media.filter((media) => media.hairstyleVariantId === variant.id)) : [];
  const coverImage = variantGallery[0] ?? serviceGallery[0] ?? null;
  const catalogVisible = row.category.isActive && row.isActive;
  const variantVisible = !variant || (row.requiresVariant && variant.isActive);
  const currentPrice = variant ? variant.priceCents : serviceStartingPrice(row);
  const bookable = catalogVisible && variantVisible && currentPrice !== null && currentPrice >= MINIMUM_BOOKABLE_PRICE_CENTS;
  const publiclyAvailable = catalogVisible && variantVisible;
  let statusMessage = "Shown publicly and available to book.";
  if (!row.category.isActive) statusMessage = "Hidden because its category is inactive.";
  else if (!row.isActive) statusMessage = "Hidden because the service is inactive.";
  else if (variant && !row.requiresVariant) statusMessage = "Hidden because this service no longer uses variant pricing.";
  else if (variant && !variant.isActive) statusMessage = "Hidden because the variant is inactive.";
  else if (!bookable) statusMessage = "Shown as portfolio-only because it is not currently bookable.";

  return {
    key: targetKey({ hairstyleId: row.id, hairstyleVariantId: variantId }),
    hairstyleId: row.id,
    hairstyleVariantId: variantId,
    hairstyleName: row.name,
    variantName: variant?.name ?? null,
    categoryName: row.category.name,
    label: variant ? `${row.name} — ${variant.name}` : row.name,
    coverImage,
    publicStatus: publiclyAvailable ? (bookable ? "available" : "portfolio-only") : "unavailable",
    statusMessage,
  };
}

async function activeFeatureRows(db: Pick<Prisma.TransactionClient, "homepageCatalogFeature"> | typeof prisma = prisma) {
  return db.homepageCatalogFeature.findMany({
    where: { isActive: true },
    select: { id: true, hairstyleId: true, hairstyleVariantId: true, sortOrder: true, updatedAt: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

export async function readHomepageFeatureAdminState(): Promise<AdminHomepageFeatureState> {
  const [rows, features] = await Promise.all([
    prisma.hairstyle.findMany({ select: featureCatalogSelect, orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }, { id: "asc" }] }),
    activeFeatureRows(),
  ]);
  const options = rows.flatMap((row) => [
    optionFor(row, null),
    ...row.variants.map((variant) => optionFor(row, variant.id)),
  ]).filter((option): option is AdminHomepageFeatureOption => option !== null);
  const byKey = new Map(options.map((option) => [option.key, option]));
  return {
    revision: revisionFor(features),
    features: features.map((feature) => byKey.get(targetKey(feature))).filter((feature): feature is AdminHomepageFeatureOption => feature !== undefined),
    options,
  };
}

/**
 * Atomically replaces the ordered active set. The advisory transaction lock
 * serializes even the empty-set case; the revision rejects stale admin tabs.
 */
export async function replaceHomepageFeatures(
  targets: HomepageFeatureTarget[],
  expectedRevision: string,
): Promise<void> {
  if (!Array.isArray(targets) || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new HomepageFeatureError("INVALID_FEATURES");
  }
  if (targets.length > MAX_HOMEPAGE_FEATURES) throw new HomepageFeatureError("FEATURE_LIMIT_EXCEEDED");
  const keys = targets.map(targetKey);
  if (new Set(keys).size !== keys.length) throw new HomepageFeatureError("DUPLICATE_FEATURE");
  if (targets.some((target) => !target.hairstyleId || target.hairstyleId.length > 64 || (target.hairstyleVariantId !== null && (!target.hairstyleVariantId || target.hairstyleVariantId.length > 64)))) {
    throw new HomepageFeatureError("INVALID_FEATURES");
  }

  await prisma.$transaction(async (tx) => {
    // `pg_advisory_xact_lock` returns PostgreSQL void, which Prisma cannot
    // deserialize directly. The boolean expression retains the blocking lock
    // acquisition while returning a supported scalar type.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${HOMEPAGE_FEATURE_LOCK_KEY}) IS NULL AS locked`;
    const current = await activeFeatureRows(tx);
    if (revisionFor(current) !== expectedRevision) throw new HomepageFeatureError("STALE_FEATURE_CONFIGURATION");

    const styleIds = [...new Set(targets.map((target) => target.hairstyleId))];
    const styles = await tx.hairstyle.findMany({
      where: { id: { in: styleIds } },
      select: { id: true, variants: { select: { id: true } } },
    });
    const byStyle = new Map(styles.map((style) => [style.id, new Set(style.variants.map((variant) => variant.id))]));
    for (const target of targets) {
      const variants = byStyle.get(target.hairstyleId);
      if (!variants) throw new HomepageFeatureError("FEATURE_TARGET_NOT_FOUND");
      if (target.hairstyleVariantId !== null && !variants.has(target.hairstyleVariantId)) {
        throw new HomepageFeatureError("VARIANT_OWNERSHIP_MISMATCH");
      }
    }

    const targetKeys = new Set(keys);
    for (const feature of current) {
      if (!targetKeys.has(targetKey(feature))) {
        await tx.homepageCatalogFeature.update({ where: { id: feature.id }, data: { isActive: false } });
      }
    }
    const currentByKey = new Map(current.map((feature) => [targetKey(feature), feature]));
    for (const [sortOrder, target] of targets.entries()) {
      const existing = currentByKey.get(targetKey(target));
      if (existing) {
        await tx.homepageCatalogFeature.update({ where: { id: existing.id }, data: { sortOrder } });
      } else {
        await tx.homepageCatalogFeature.create({ data: { ...target, sortOrder, isActive: true } });
      }
    }
  });
}

export async function listPublicHomepageFeatures(): Promise<PublicHomepageFeature[]> {
  const features = await prisma.homepageCatalogFeature.findMany({
    where: { isActive: true },
    select: {
      id: true,
      hairstyleVariantId: true,
      hairstyle: { select: featureCatalogSelect },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  return features.flatMap((feature): PublicHomepageFeature[] => {
    const option = optionFor(feature.hairstyle, feature.hairstyleVariantId);
    if (!option || option.publicStatus === "unavailable") return [];
    const variant = feature.hairstyleVariantId === null
      ? null
      : feature.hairstyle.variants.find((candidate) => candidate.id === feature.hairstyleVariantId) ?? null;
    const priceCents = variant?.priceCents ?? serviceStartingPrice(feature.hairstyle);
    const href = variant && option.publicStatus === "available"
      ? `/book?style=${encodeURIComponent(feature.hairstyle.slug)}&variant=${encodeURIComponent(variant.id)}`
      : `/styles/${encodeURIComponent(feature.hairstyle.slug)}`;
    return [{
      id: feature.id,
      name: variant?.name ?? feature.hairstyle.name,
      serviceName: feature.hairstyle.name,
      variantName: variant?.name ?? null,
      priceCents,
      coverImage: option.coverImage,
      href,
    }];
  }).slice(0, MAX_HOMEPAGE_FEATURES);
}
