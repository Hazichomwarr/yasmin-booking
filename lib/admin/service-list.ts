export type AdminServiceListState = "active" | "inactive" | "draft" | "";

export type AdminServiceListItem = {
  id: string;
  name: string;
  priceCents: number | null;
  requiresVariant: boolean;
  isActive: boolean;
  sortOrder: number;
  category: { id: string; name: string };
};

export const ADMIN_SERVICE_BATCH_SIZE = 10;

export function filterAdminServices(
  services: AdminServiceListItem[],
  filter: { search: string; categoryId: string; state: AdminServiceListState },
): AdminServiceListItem[] {
  const search = filter.search.trim().toLocaleLowerCase("en-US");
  return services.filter((service) => {
    if (filter.categoryId && service.category.id !== filter.categoryId) return false;
    if (filter.state === "active" && (!service.isActive || (!service.requiresVariant && service.priceCents === null))) return false;
    if (filter.state === "inactive" && service.isActive) return false;
    if (filter.state === "draft" && (service.requiresVariant || service.priceCents !== null)) return false;
    return !search || service.name.toLocaleLowerCase("en-US").includes(search);
  });
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
