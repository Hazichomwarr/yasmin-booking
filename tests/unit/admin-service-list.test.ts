import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADMIN_SERVICE_BATCH_SIZE,
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
    category: { id: index % 2 ? "braids" : "locs", name: index % 2 ? "Braids" : "Locs" },
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
      filterAdminServices(services, { search: "  KNOTLESS  ", categoryId: "", state: "" }).map(({ id }) => id),
      ["service-1", "service-3"],
    );
    assert.deepEqual(filterAdminServices(services, { search: "missing", categoryId: "", state: "" }), []);
  });

  it("combines category, publication status, and search filters", () => {
    const services = [
      service(1, { name: "Active Braids" }),
      service(2, { name: "Active Locs" }),
      service(3, { name: "Inactive Braids", isActive: false }),
      service(5, { name: "Draft Braids", priceCents: null }),
    ];
    assert.deepEqual(filterAdminServices(services, { search: "braids", categoryId: "braids", state: "active" }).map(({ id }) => id), ["service-1"]);
    assert.deepEqual(filterAdminServices(services, { search: "", categoryId: "braids", state: "inactive" }).map(({ id }) => id), ["service-3"]);
    assert.deepEqual(filterAdminServices(services, { search: "", categoryId: "braids", state: "draft" }).map(({ id }) => id), ["service-5"]);
  });

  it("accepts only local Services-list return paths", () => {
    assert.equal(safeAdminServicesReturnPath("/admin/services?category=braids&q=boho"), "/admin/services?category=braids&q=boho");
    assert.equal(safeAdminServicesReturnPath("/admin/services/other"), "/admin/services");
    assert.equal(safeAdminServicesReturnPath("https://example.com/admin/services"), "/admin/services");
  });
});
