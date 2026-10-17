-- Catalog variants and immutable commercial snapshots (YASMIN-3A).
-- Existing Appointment rows remain unchanged: NULL variant/currency snapshots
-- accurately preserve facts not captured by the previous model.

ALTER TABLE "Hairstyle"
  ADD COLUMN "priceCents" INTEGER,
  ADD COLUMN "requiresVariant" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "HairstyleVariant" (
  "id" TEXT NOT NULL,
  "hairstyleId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "priceCents" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HairstyleVariant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Appointment"
  ADD COLUMN "hairstyleVariantId" TEXT,
  ADD COLUMN "hairstyleVariantNameSnapshot" TEXT,
  ADD COLUMN "currency" TEXT;

CREATE UNIQUE INDEX "HairstyleVariant_hairstyleId_name_key" ON "HairstyleVariant"("hairstyleId", "name");
CREATE INDEX "HairstyleVariant_hairstyleId_isActive_sortOrder_idx" ON "HairstyleVariant"("hairstyleId", "isActive", "sortOrder");
CREATE INDEX "Appointment_hairstyleVariantId_idx" ON "Appointment"("hairstyleVariantId");

ALTER TABLE "HairstyleVariant" ADD CONSTRAINT "HairstyleVariant_hairstyleId_fkey"
  FOREIGN KEY ("hairstyleId") REFERENCES "Hairstyle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_hairstyleVariantId_fkey"
  FOREIGN KEY ("hairstyleVariantId") REFERENCES "HairstyleVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Hairstyle"
  ADD CONSTRAINT "Hairstyle_price_cents_minimum"
  CHECK ("priceCents" IS NULL OR "priceCents" >= 4000);
ALTER TABLE "HairstyleVariant"
  ADD CONSTRAINT "HairstyleVariant_price_cents_minimum"
  CHECK ("priceCents" IS NULL OR "priceCents" >= 4000);
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_currency_usd_or_legacy_null"
  CHECK ("currency" IS NULL OR "currency" = 'usd');
