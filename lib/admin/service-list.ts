export type AdminServicesView = "hairstyles" | "categories" | "published" | "drafts";

export type AdminServiceCoverImage = {
  deliveryUrl: string;
  altText: string | null;
};

export type AdminServiceListItem = {
  id: string;
  name: string;
  priceCents: number | null;
  requiresVariant: boolean;
  isActive: boolean;
  sortOrder: number;
  coverImage: AdminServiceCoverImage | null;
  category: { id: string; name: string; isActive: boolean };
};

export const ADMIN_SERVICE_BATCH_SIZE = 10;

export function filterAdminServices(
  services: AdminServiceListItem[],
  filter: { search: string; categoryId: string; view: Exclude<AdminServicesView, "categories"> },
): AdminServiceListItem[] {
  const search = filter.search.trim().toLocaleLowerCase("en-US");
  return services.filter((service) => {
    if (filter.categoryId && service.category.id !== filter.categoryId) return false;
    if (filter.view === "published" && !service.isActive) return false;
    if (filter.view === "drafts" && service.isActive) return false;
    return !search
      || service.name.toLocaleLowerCase("en-US").includes(search)
      || service.category.name.toLocaleLowerCase("en-US").includes(search);
  });
}

export function adminServicesPath(input: {
  view: AdminServicesView;
  search?: string;
  categoryId?: string;
}): string {
  const params = new URLSearchParams();
  if (input.view !== "hairstyles") params.set("view", input.view);
  if (input.categoryId) params.set("category", input.categoryId);
  if (input.search?.trim()) params.set("q", input.search.trim());
  const query = params.toString();
  return `/admin/services${query ? `?${query}` : ""}`;
}

export function nextAdminServiceVisibleCount(current: number, total: number): number {
  return Math.min(current + ADMIN_SERVICE_BATCH_SIZE, total);
}

export function visibleAdminServices<T>(services: T[], visibleCount: number): T[] {
  return services.slice(0, visibleCount);
}

export function safeAdminServicesReturnPath(value: string | undefined): string {
  if (!value) return "/admin/services";
  try {
    const parsed = new URL(value, "https://admin.local");
    if (parsed.origin !== "https://admin.local" || parsed.pathname !== "/admin/services") return "/admin/services";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/admin/services";
  }
}
