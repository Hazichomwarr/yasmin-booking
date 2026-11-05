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

export type AdminServiceListFilter = {
  search: string;
  categoryId: string;
  view: Exclude<AdminServicesView, "categories">;
};

export function filterAdminServices(
  services: AdminServiceListItem[],
  filter: AdminServiceListFilter,
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
  visibleCount?: number;
}): string {
  const params = new URLSearchParams();
  if (input.view !== "hairstyles") params.set("view", input.view);
  if (input.categoryId) params.set("category", input.categoryId);
  if (input.search?.trim()) params.set("q", input.search.trim());
  if (input.visibleCount && input.visibleCount > ADMIN_SERVICE_BATCH_SIZE) params.set("show", String(input.visibleCount));
  const query = params.toString();
  return `/admin/services${query ? `?${query}` : ""}`;
}

export function nextAdminServiceVisibleCount(current: number, total: number): number {
  return Math.min(current + ADMIN_SERVICE_BATCH_SIZE, total);
}

export function visibleAdminServices<T>(services: T[], visibleCount: number): T[] {
  return services.slice(0, visibleCount);
}

export function adminServiceVisibleCount(value: string | string[] | undefined): number {
  if (typeof value !== "string") return ADMIN_SERVICE_BATCH_SIZE;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= ADMIN_SERVICE_BATCH_SIZE
    ? Math.min(parsed, 1_000)
    : ADMIN_SERVICE_BATCH_SIZE;
}

export function safeAdminServicesReturnPath(value: string | undefined): string {
  if (!value) return "/admin/services";
  try {
    const parsed = new URL(value, "https://admin.local");
    if (parsed.origin !== "https://admin.local" || parsed.pathname !== "/admin/services") return "/admin/services";
    const requestedView = parsed.searchParams.get("view");
    const view: AdminServicesView = requestedView === "categories" || requestedView === "published" || requestedView === "drafts"
      ? requestedView
      : "hairstyles";
    return adminServicesPath({
      view,
      categoryId: parsed.searchParams.get("category") ?? undefined,
      search: parsed.searchParams.get("q") ?? undefined,
      visibleCount: adminServiceVisibleCount(parsed.searchParams.get("show") ?? undefined),
    });
  } catch {
    return "/admin/services";
  }
}

export type AdminServiceEditNavigation = {
  previousId: string | null;
  nextId: string | null;
  position: number;
  total: number;
};

/** The input order comes from the catalog domain's deterministic database order. */
export function adminServiceEditNavigation(
  services: AdminServiceListItem[],
  currentId: string,
  returnTo: string,
): AdminServiceEditNavigation {
  const safeReturnTo = safeAdminServicesReturnPath(returnTo);
  const parsed = new URL(safeReturnTo, "https://admin.local");
  const requestedView = parsed.searchParams.get("view");
  const filteredView = requestedView === "published" || requestedView === "drafts" ? requestedView : "hairstyles";
  const hasListView = requestedView !== "categories";
  const filtered = hasListView
    ? filterAdminServices(services, {
        view: filteredView,
        search: parsed.searchParams.get("q") ?? "",
        categoryId: parsed.searchParams.get("category") ?? "",
      })
    : services;
  const ordered = filtered.some(({ id }) => id === currentId) ? filtered : services;
  const index = ordered.findIndex(({ id }) => id === currentId);
  if (index < 0) return { previousId: null, nextId: null, position: 0, total: ordered.length };
  return {
    previousId: ordered[index - 1]?.id ?? null,
    nextId: ordered[index + 1]?.id ?? null,
    position: index + 1,
    total: ordered.length,
  };
}

export function adminServiceEditPath(serviceId: string, returnTo: string): string {
  return `/admin/services/${encodeURIComponent(serviceId)}/edit?returnTo=${encodeURIComponent(safeAdminServicesReturnPath(returnTo))}`;
}
