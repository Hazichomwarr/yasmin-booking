-- Explicit, catalog-owned homepage curation (YASMIN-4E.2).
-- The feature rows contain only stable catalog identities and independent
-- homepage order. No appointment, payment, event, price, or media data is
-- copied or rewritten.

CREATE TABLE "HomepageCatalogFeature" (
  "id" TEXT NOT NULL,
  "hairstyleId" TEXT NOT NULL,
  "hairstyleVariantId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HomepageCatalogFeature_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomepageCatalogFeature_isActive_sortOrder_createdAt_id_idx"
  ON "HomepageCatalogFeature"("isActive", "sortOrder", "createdAt", "id");
CREATE INDEX "HomepageCatalogFeature_hairstyleId_idx"
  ON "HomepageCatalogFeature"("hairstyleId");
CREATE INDEX "HomepageCatalogFeature_hairstyleVariantId_idx"
  ON "HomepageCatalogFeature"("hairstyleVariantId");

-- PostgreSQL treats NULL values as distinct in ordinary unique constraints.
-- Partial indexes close that gap for service-only targets while retaining
-- inactive configuration history.
CREATE UNIQUE INDEX "HomepageCatalogFeature_active_service_target_key"
  ON "HomepageCatalogFeature"("hairstyleId")
  WHERE "isActive" = true AND "hairstyleVariantId" IS NULL;
CREATE UNIQUE INDEX "HomepageCatalogFeature_active_variant_target_key"
  ON "HomepageCatalogFeature"("hairstyleVariantId")
  WHERE "isActive" = true AND "hairstyleVariantId" IS NOT NULL;

ALTER TABLE "HomepageCatalogFeature"
  ADD CONSTRAINT "HomepageCatalogFeature_hairstyleId_fkey"
  FOREIGN KEY ("hairstyleId") REFERENCES "Hairstyle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HomepageCatalogFeature"
  ADD CONSTRAINT "HomepageCatalogFeature_hairstyleVariantId_hairstyleId_fkey"
  FOREIGN KEY ("hairstyleVariantId", "hairstyleId")
  REFERENCES "HairstyleVariant"("id", "hairstyleId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
