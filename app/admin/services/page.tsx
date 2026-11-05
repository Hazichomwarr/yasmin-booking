import Link from "next/link";

import { AdminShell } from "@/components/admin/AdminShell";
import { AdminHomepageFeatures } from "@/components/admin/AdminHomepageFeatures";
import { AdminCategoryManager } from "@/components/admin/AdminCategoryManager";
import { AdminServiceCatalog } from "@/components/admin/AdminServiceCatalog";
import styles from "@/components/admin/Admin.module.css";
import { getAdminHomepageFeatures, listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";

export default async function AdminServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requireAdmin();
  const query = await searchParams;
  const categoryId = typeof query.category === "string" ? query.category : undefined;
  const state = query.state === "active" || query.state === "inactive" || query.state === "draft" ? query.state : undefined;
  const search = typeof query.q === "string" ? query.q : "";
  const [{ categories, hairstyles }, homepageFeatures] = await Promise.all([
    listAdminCatalog(access),
    getAdminHomepageFeatures(access),
  ]);

  return <AdminShell current="services" email={access.email}>
    <div className={styles.catalogHeading}>
      <div><p className={styles.eyebrow}>Catalog</p><h1 className={styles.title}>Services</h1></div>
      <Link className={styles.primary} href="/admin/services/new">Add Service</Link>
    </div>
    <AdminCategoryManager initialCategories={categories.map(({ id, name, slug, description, isActive, sortOrder, hairstyleCount }) => ({ id, name, slug, description, isActive, sortOrder, hairstyleCount }))} />
    <AdminHomepageFeatures initialState={homepageFeatures} />
    <AdminServiceCatalog categories={categories.map(({ id, name }) => ({ id, name }))} services={hairstyles.map(({ id, name, priceCents, requiresVariant, isActive, sortOrder, category }) => ({ id, name, priceCents, requiresVariant, isActive, sortOrder, category: { id: category.id, name: category.name } }))} initialCategoryId={categoryId} initialState={state} initialSearch={search} />
  </AdminShell>;
}
