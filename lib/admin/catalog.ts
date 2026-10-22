import {
  listCategoriesForAdmin,
  listHairstylesForAdmin,
  getHairstyleDetailForAdmin,
  type AdminCategory,
  type AdminHairstyle,
  type AdminHairstyleDetail,
  readHomepageFeatureAdminState,
  replaceHomepageFeatures,
  type AdminHomepageFeatureState,
  type HomepageFeatureTarget,
} from "@/lib/catalog";

import { assertAdminAccess, type AdminAccess } from "./auth";

/** Admin-only catalog read used by Server Components. Mutations remain behind
 * their authenticated HTTP boundary; customer booking never calls this. */
export async function listAdminCatalog(
  access: AdminAccess,
  filter: { categoryId?: string; state?: "active" | "inactive" | "draft" } = {},
): Promise<{ categories: AdminCategory[]; hairstyles: AdminHairstyle[] }> {
  assertAdminAccess(access);
  const [categories, all] = await Promise.all([
    listCategoriesForAdmin(),
    listHairstylesForAdmin({ categoryId: filter.categoryId }),
  ]);
  const hairstyles = all.filter((style) => {
    if (filter.state === "active") return style.isActive && (style.requiresVariant || style.priceCents !== null);
    if (filter.state === "inactive") return !style.isActive;
    if (filter.state === "draft") return style.requiresVariant ? false : style.priceCents === null;
    return true;
  });
  return { categories, hairstyles };
}

export async function getAdminHairstyleDetail(
  access: AdminAccess,
  hairstyleId: string,
): Promise<AdminHairstyleDetail> {
  assertAdminAccess(access);
  return getHairstyleDetailForAdmin(hairstyleId);
}

export async function getAdminHomepageFeatures(access: AdminAccess): Promise<AdminHomepageFeatureState> {
  assertAdminAccess(access);
  return readHomepageFeatureAdminState();
}

export async function setAdminHomepageFeatures(
  access: AdminAccess,
  targets: HomepageFeatureTarget[],
  expectedRevision: string,
): Promise<AdminHomepageFeatureState> {
  assertAdminAccess(access);
  await replaceHomepageFeatures(targets, expectedRevision);
  return readHomepageFeatureAdminState();
}
