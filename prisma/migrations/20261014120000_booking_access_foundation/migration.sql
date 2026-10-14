-- Anonymous customer booking access (YASMIN-1F.1).
--
-- Adds the hash-only booking-access credential to Appointment, the
-- ACCESS_REVOKED audit event type, and CHECK constraints for the credential
-- invariants (Prisma cannot express CHECKs; it neither introspects nor drops
-- them).
--
-- Existing data: purely additive. The new columns are nullable with no
-- default, so no row is rewritten or backfilled; every existing appointment
-- keeps all four columns NULL, meaning "no public access", which satisfies
-- every constraint below. No existing event, payment or constraint changes.
--
-- The enum value is only added, never used, in this script, so ADD VALUE is
-- safe inside the implicit transaction (PostgreSQL 12+). No explicit
-- BEGIN/COMMIT: a failure leaves no partial change.

-- AlterEnum
ALTER TYPE "AppointmentEventType" ADD VALUE 'ACCESS_REVOKED';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accessTokenHash" TEXT,
ADD COLUMN     "accessTokenIssuedAt" TIMESTAMP(3),
ADD COLUMN     "accessTokenRevokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_accessTokenHash_key" ON "Appointment"("accessTokenHash");

-- Booking-access invariants.
ALTER TABLE "Appointment"
  -- A credential is complete or absent.
  ADD CONSTRAINT "Appointment_access_token_complete"
    CHECK (("accessTokenHash" IS NULL) = ("accessTokenIssuedAt" IS NULL)
       AND ("accessTokenHash" IS NULL) = ("accessTokenExpiresAt" IS NULL)),
  -- Only a credential can be revoked.
  ADD CONSTRAINT "Appointment_access_revoked_has_token"
    CHECK ("accessTokenRevokedAt" IS NULL OR "accessTokenHash" IS NOT NULL),
  -- Only a SHA-256 digest is stored (lowercase hex), never a raw token.
  ADD CONSTRAINT "Appointment_access_token_hash_sha256"
    CHECK ("accessTokenHash" IS NULL OR "accessTokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Appointment_access_expires_after_issue"
    CHECK ("accessTokenExpiresAt" IS NULL OR "accessTokenExpiresAt" > "accessTokenIssuedAt");
