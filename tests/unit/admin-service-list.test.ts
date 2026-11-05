import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADMIN_SERVICE_BATCH_SIZE,
  adminServicesPath,
  filterAdminServices,
  nextAdminServiceVisibleCount,
  safeAdminServicesReturnPath,
  visibleAdminServices,
  type AdminServiceListItem,
} from "@/lib/admin/service-list";

function service(index: number, overrides: Partial<AdminServiceListItem> = {}): AdminServiceListItem {
  return {
    id: `service-${index}`,
    name: `Style ${String(index).padStart(2, "0")}`,
    priceCents: 20_000,
    requiresVariant: false,
    isActive: true,
    sortOrder: index,
    coverImage: null,
    category: { id: index % 2 ? "braids" : "locs", name: index % 2 ? "Braids" : "Locs", isActive: true },
    ...overrides,
  };
}

describe("admin service list", () => {
  it("shows batches of ten followed by a final partial batch", () => {
    const services = Array.from({ length: 25 }, (_, index) => service(index));
    assert.equal(ADMIN_SERVICE_BATCH_SIZE, 10);
    assert.equal(visibleAdminServices(services, ADMIN_SERVICE_BATCH_SIZE).length, 10);
    assert.equal(nextAdminServiceVisibleCount(10, 25), 20);
    assert.equal(visibleAdminServices(services, 20).length, 20);
    assert.equal(nextAdminServiceVisibleCount(20, 25), 25);
    assert.equal(visibleAdminServices(services, 25).length, 25);
    assert.equal(nextAdminServiceVisibleCount(25, 25), 25);
  });

  it("searches names case-insensitively with trimmed input without changing ordering", () => {
    const services = [service(1, { name: "Knotless Braids" }), service(2), service(3, { name: "Boho Knotless" })];
    assert.deepEqual(
      filterAdminServices(services, { search: "  KNOTLESS  ", categoryId: "", view: "hairstyles" }).map(({ id }) => id),
      ["service-1", "service-3"],
    );
    assert.deepEqual(filterAdminServices(services, { search: "missing", categoryId: "", view: "hairstyles" }), []);
  });

  it("matches category names and combines them with the selected category and view", () => {
    const services = [
      service(1, { name: "Knotless", category: { id: "braids", name: "Braids & Twists", isActive: true } }),
      service(2, { name: "Starter", category: { id: "locs", name: "Loc Maintenance", isActive: true } }),
      service(3, { name: "Draft Knotless", isActive: false, category: { id: "braids", name: "Braids & Twists", isActive: true } }),
    ];

    assert.deepEqual(
      filterAdminServices(services, { search: "  TWISTS ", categoryId: "braids", view: "published" }).map(({ id }) => id),
      ["service-1"],
    );
    assert.deepEqual(
      filterAdminServices(services, { search: "braids", categoryId: "braids", view: "drafts" }).map(({ id }) => id),
      ["service-3"],
    );
  });

  it("filters the complete catalog before applying progressive display", () => {
    const services = Array.from({ length: 24 }, (_, index) => service(index, {
      name: `${index < 15 ? "Braided" : "Other"} Style ${index}`,
      category: { id: "other", name: "Other Category", isActive: true },
    }));
    const matching = filterAdminServices(services, { search: "braid", categoryId: "", view: "hairstyles" });

    assert.equal(matching.length, 15);
    assert.equal(visibleAdminServices(matching, ADMIN_SERVICE_BATCH_SIZE).length, 10);
    assert.equal(visibleAdminServices(matching, nextAdminServiceVisibleCount(10, matching.length)).length, 15);
  });

  it("combines category, publication status, and search filters", () => {
    const services = [
      service(1, { name: "Active Braids" }),
      service(2, { name: "Active Locs" }),
      service(3, { name: "Inactive Braids", isActive: false }),
      service(5, { name: "Unpriced Published Braids", priceCents: null }),
    ];
    assert.deepEqual(filterAdminServices(services, { search: "braids", categoryId: "braids", view: "published" }).map(({ id }) => id), ["service-1", "service-5"]);
    assert.deepEqual(filterAdminServices(services, { search: "", categoryId: "braids", view: "drafts" }).map(({ id }) => id), ["service-3"]);
    assert.deepEqual(filterAdminServices(services, { search: "", categoryId: "braids", view: "hairstyles" }).map(({ id }) => id), ["service-1", "service-3", "service-5"]);
  });

  it("keeps active services in Published when their category is inactive", () => {
    const hiddenByCategory = service(1, { category: { id: "braids", name: "Braids", isActive: false } });
    assert.deepEqual(filterAdminServices([hiddenByCategory], { search: "", categoryId: "", view: "published" }).map(({ id }) => id), ["service-1"]);
  });

  it("builds deterministic view paths while preserving list context", () => {
    assert.equal(adminServicesPath({ view: "hairstyles", search: " boho ", categoryId: "braids" }), "/admin/services?category=braids&q=boho");
    assert.equal(adminServicesPath({ view: "published", search: "boho", categoryId: "braids" }), "/admin/services?view=published&category=braids&q=boho");
    assert.equal(adminServicesPath({ view: "categories" }), "/admin/services?view=categories");
  });

  it("accepts only local Services-list return paths", () => {
    assert.equal(safeAdminServicesReturnPath("/admin/services?view=published&category=braids&q=boho"), "/admin/services?view=published&category=braids&q=boho");
    assert.equal(safeAdminServicesReturnPath("/admin/services/other"), "/admin/services");
    assert.equal(safeAdminServicesReturnPath("https://example.com/admin/services"), "/admin/services");
  });
});
