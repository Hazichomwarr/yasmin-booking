import { AdminServiceEditor } from "@/components/admin/AdminServiceEditor";
import { AdminShell } from "@/components/admin/AdminShell";
import styles from "@/components/admin/Admin.module.css";
import { getAdminHairstyleDetail, listAdminCatalog } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/admin/dal";
import { listHairstyleMedia } from "@/lib/catalog";
import { adminServiceEditNavigation, safeAdminServicesReturnPath } from "@/lib/admin/service-list";

export default async function EditAdminServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ serviceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAdmin();
  const { serviceId } = await params;
  const query = await searchParams;
  const returnTo = safeAdminServicesReturnPath(typeof query.returnTo === "string" ? query.returnTo : undefined);
  const [catalog, service] = await Promise.all([
    listAdminCatalog(access),
    getAdminHairstyleDetail(access, serviceId),
  ]);
  const navigation = adminServiceEditNavigation(
    catalog.hairstyles.map(({ id, name, priceCents, requiresVariant, isActive, sortOrder, category }) => ({
      id,
      name,
      priceCents,
      requiresVariant,
      isActive,
      sortOrder,
      coverImage: null,
      category: { id: category.id, name: category.name, isActive: category.isActive },
    })),
    service.id,
    returnTo,
  );
  const variantMedia = await Promise.all(
    service.variants.map(async (variant) => [variant.id, await listHairstyleMedia(service.id, variant.id)] as const),
  );
  const mediaByVariant = new Map(variantMedia);

  return (
    <AdminShell current="services" email={access.email}>
      <p className={styles.eyebrow}>Catalog</p>
      <AdminServiceEditor
        returnTo={returnTo}
        navigation={navigation}
        categories={catalog.categories.map(({ id, name }) => ({ id, name }))}
        service={{
          id: service.id,
          name: service.name,
          categoryId: service.category.id,
          description: service.description,
          priceCents: service.priceCents,
          requiresVariant: service.requiresVariant,
          isActive: service.isActive,
          sortOrder: service.sortOrder,
          variants: service.variants.map((variant) => ({ ...variant, media: mediaByVariant.get(variant.id) ?? [] })),
          media: service.media,
        }}
      />
    </AdminShell>
  );
}
