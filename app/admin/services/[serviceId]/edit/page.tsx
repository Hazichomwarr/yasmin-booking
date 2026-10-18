import { AdminServiceEditor } from "@/components/admin/AdminServiceEditor";
import { AdminShell } from "@/components/admin/AdminShell";
import styles from "@/components/admin/Admin.module.css";
import { getAdminHairstyleDetail, listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";

export default async function EditAdminServicePage({
  params,
}: {
  params: Promise<{ serviceId: string }>;
}) {
  const access = await requireAdmin();
  const { serviceId } = await params;
  const [{ categories }, service] = await Promise.all([
    listAdminCatalog(access),
    getAdminHairstyleDetail(access, serviceId),
  ]);

  return (
    <AdminShell current="services" email={access.email}>
      <p className={styles.eyebrow}>Catalog</p>
      <h1 className={styles.title}>Edit service</h1>
      <section className={styles.panel}>
        <p className={styles.formIntro}>Update the current catalog configuration. Existing bookings keep their historical service and price snapshots.</p>
        <AdminServiceEditor
          categories={categories.map(({ id, name }) => ({ id, name }))}
          service={{
            id: service.id,
            name: service.name,
            categoryId: service.category.id,
            description: service.description,
            priceCents: service.priceCents,
            requiresVariant: service.requiresVariant,
            isActive: service.isActive,
            sortOrder: service.sortOrder,
            variants: service.variants,
            media: service.media,
          }}
        />
      </section>
    </AdminShell>
  );
}
