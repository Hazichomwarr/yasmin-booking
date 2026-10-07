-- SalonLocation.timeZone: IANA timezone identifier defining the location's
-- local calendar "today" for booking policy. Current configuration only;
-- Appointment snapshots are not touched.
--
-- Existing rows are backfilled explicitly. The only known location is
-- William Street (America/New_York). Any other existing location has no
-- knowable timezone, so the migration fails instead of guessing.
--
-- No explicit BEGIN/COMMIT: PostgreSQL runs this multi-statement script as one
-- implicit transaction, so a failure leaves no partial change (verified
-- locally), and Prisma reports the RAISE message below.

ALTER TABLE "SalonLocation" ADD COLUMN "timeZone" TEXT;

UPDATE "SalonLocation" SET "timeZone" = 'America/New_York' WHERE "id" = 'william-street';

-- Fail with an explicit message (rather than a generic NOT NULL violation)
-- if any row still has no timezone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SalonLocation" WHERE "timeZone" IS NULL) THEN
    RAISE EXCEPTION 'SalonLocation rows without a known timezone exist; set "timeZone" for them explicitly before applying this migration.';
  END IF;

  ALTER TABLE "SalonLocation" ALTER COLUMN "timeZone" SET NOT NULL;
END $$;
