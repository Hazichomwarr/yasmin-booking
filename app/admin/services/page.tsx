import Link from "next/link";

import { AdminShell } from "@/components/admin/AdminShell";
import styles from "@/components/admin/Admin.module.css";
import { listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";

function dollars(cents: number | null) {
  return cents === null ? "Draft" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default async function AdminServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requireAdmin();
  const query = await searchParams;
  const categoryId = typeof query.category === "string" ? query.category : undefined;
  const state = query.state === "active" || query.state === "inactive" || query.state === "draft" ? query.state : undefined;
  const { categories, hairstyles } = await listAdminCatalog(access, { categoryId, state });

  return <AdminShell current="services" email={access.email}>
    <div className={styles.catalogHeading}>
      <div><p className={styles.eyebrow}>Catalog</p><h1 className={styles.title}>Services</h1></div>
      <Link className={styles.primary} href="/admin/services/new">Add Service</Link>
    </div>
    <section className={styles.panel} aria-label="Service filters">
      <form className={styles.filters} method="get">
        <label>Category<select name="category" defaultValue={categoryId ?? ""}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label>Status<select name="state" defaultValue={state ?? ""}><option value="">All states</option><option value="active">Active</option><option value="draft">Draft</option><option value="inactive">Inactive</option></select></label>
        <div className={styles.filterActions}><button className={styles.primary} type="submit">Apply</button><Link href="/admin/services">Clear</Link></div>
      </form>
    </section>
    {hairstyles.length === 0 ? <section className={styles.panel}><p className={styles.empty}>No services match this view. Start the catalog with a bookable service or save an unpriced draft.</p><Link className={styles.primary} href="/admin/services/new">Add Service</Link></section> :
      <section className={styles.catalogList} aria-label="Services">
        {hairstyles.map((style) => <article className={styles.catalogCard} key={style.id}>
          <div><p className={styles.catalogCategory}>{style.category.name}</p><h2>{style.name}</h2><p className={styles.muted}>{style.requiresVariant ? "Variant pricing" : dollars(style.priceCents)} · Order {style.sortOrder}</p></div>
          <div className={styles.catalogActions}><span className={styles.badge} data-catalog-state={!style.isActive ? "inactive" : style.priceCents === null && !style.requiresVariant ? "draft" : "active"}>{!style.isActive ? "Inactive" : style.priceCents === null && !style.requiresVariant ? "Draft" : "Active"}</span><Link className={styles.secondary} href={`/admin/services/${style.id}/edit`}>Edit</Link></div>
        </article>)}
      </section>}
  </AdminShell>;
}
