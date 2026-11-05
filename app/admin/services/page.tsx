import Link from "next/link";

import { AdminShell } from "@/components/admin/AdminShell";
import { AdminHomepageFeatures } from "@/components/admin/AdminHomepageFeatures";
import { AdminCategoryManager } from "@/components/admin/AdminCategoryManager";
import { AdminServiceCatalog } from "@/components/admin/AdminServiceCatalog";
import { AdminServicesSubnav } from "@/components/admin/AdminServicesSubnav";
import styles from "@/components/admin/Admin.module.css";
import { getAdminHomepageFeatures, listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";
import type { AdminServicesView } from "@/lib/admin/service-list";

function servicesView(query: Record<string, string | string[] | undefined>): AdminServicesView {
  if (query.view === "categories" || query.view === "published" || query.view === "drafts") return query.view;
  // Preserve useful legacy links from the previous status-filter interface.
  if (query.state === "active") return "published";
  if (query.state === "inactive" || query.state === "draft") return "drafts";
  return "hairstyles";
}

export default async function AdminServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requireAdmin();
  const query = await searchParams;
  const view = servicesView(query);
  const categoryId = typeof query.category === "string" ? query.category : undefined;
  const search = typeof query.q === "string" ? query.q : "";
  const { categories, hairstyles } = await listAdminCatalog(access);
  const homepageFeatures = view === "categories" ? null : await getAdminHomepageFeatures(access);
  const coverByHairstyleId = new Map(
    homepageFeatures?.options
      .filter((option) => option.hairstyleVariantId === null)
      .map((option) => [option.hairstyleId, option.coverImage] as const) ?? [],
  );
  const listView = view === "published" || view === "drafts" ? view : "hairstyles";

  return <AdminShell current="services" email={access.email}>
    <div className={styles.catalogHeading}>
      <div><p className={styles.eyebrow}>Catalog</p><h1 className={styles.title}>Services</h1></div>
      <Link className={styles.primary} href="/admin/services/new">Add Service</Link>
    </div>
    <AdminServicesSubnav current={view} search={search} categoryId={categoryId ?? ""} />
    {view === "categories" ? (
      <AdminCategoryManager initialCategories={categories.map(({ id, name, slug, description, isActive, sortOrder, hairstyleCount }) => ({ id, name, slug, description, isActive, sortOrder, hairstyleCount }))} />
    ) : (
      <>
        {view === "published" && homepageFeatures ? (
          <details className={styles.homepageFeatureDisclosure}>
            <summary>Homepage Featured Styles</summary>
            <AdminHomepageFeatures initialState={homepageFeatures} />
          </details>
        ) : null}
        <AdminServiceCatalog
          categories={categories.map(({ id, name }) => ({ id, name }))}
          services={hairstyles.map(({ id, name, priceCents, requiresVariant, isActive, sortOrder, category }) => ({
            id,
            name,
            priceCents,
            requiresVariant,
            isActive,
            sortOrder,
            coverImage: coverByHairstyleId.get(id) ?? null,
            category: { id: category.id, name: category.name, isActive: category.isActive },
          }))}
          view={listView}
          initialCategoryId={categoryId}
          initialSearch={search}
        />
      </>
    )}
  </AdminShell>;
}
