-- Variant descriptions and galleries (YASMIN-3D.3).
-- This is additive: existing media has a NULL hairstyleVariantId and remains
-- in its existing service-level gallery. Appointment snapshots are untouched.

ALTER TABLE "HairstyleVariant"
  ADD COLUMN "description" TEXT;

ALTER TABLE "HairstyleMedia"
  ADD COLUMN "hairstyleVariantId" TEXT;

CREATE UNIQUE INDEX "HairstyleVariant_id_hairstyleId_key"
  ON "HairstyleVariant"("id", "hairstyleId");

CREATE INDEX "HairstyleMedia_hairstyleVariantId_type_sortOrder_idx"
  ON "HairstyleMedia"("hairstyleVariantId", "type", "sortOrder");

ALTER TABLE "HairstyleMedia"
  ADD CONSTRAINT "HairstyleMedia_hairstyleVariantId_hairstyleId_fkey"
  FOREIGN KEY ("hairstyleVariantId", "hairstyleId")
  REFERENCES "HairstyleVariant"("id", "hairstyleId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
