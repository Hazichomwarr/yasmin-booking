import { AdminServiceEditor } from "@/components/admin/AdminServiceEditor";
import { AdminShell } from "@/components/admin/AdminShell";
import styles from "@/components/admin/Admin.module.css";
import { listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";

export default async function NewAdminServicePage() {
  const access = await requireAdmin();
  const { categories } = await listAdminCatalog(access);

  return (
    <AdminShell current="services" email={access.email}>
      <p className={styles.eyebrow}>Catalog</p>
      <h1 className={styles.title}>Add service</h1>
      <section className={styles.panel}>
        <p className={styles.formIntro}>Choose one server-managed USD price or set prices by variant. Existing bookings always keep their original service and price snapshots.</p>
        <AdminServiceEditor categories={categories.map(({ id, name }) => ({ id, name }))} />
      </section>
    </AdminShell>
  );
}
