-- Admin authentication (YASMIN-2A).
--
-- 1. AdminUser gains a scrypt password hash, its change time, and a
--    disabled flag. All three are nullable with no default: every existing
--    AdminUser row is kept unchanged and simply cannot sign in until an
--    operator provisions a password (scripts/admin-provision.ts).
-- 2. AdminSession: database-backed sessions. Only the SHA-256 of the
--    browser token is stored. Sessions are revoked, never deleted.
--
-- Existing data: purely additive. No row is rewritten or backfilled; no
-- existing column, constraint or index changes.
--
-- No explicit BEGIN/COMMIT: the script runs in one transaction.

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Admin credential invariants.
ALTER TABLE "AdminUser"
  -- Only a self-describing scrypt hash is ever stored, never a plaintext password.
  ADD CONSTRAINT "AdminUser_password_hash_scrypt"
    CHECK ("passwordHash" IS NULL OR "passwordHash" ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$'),
  ADD CONSTRAINT "AdminUser_password_time_pair"
    CHECK (("passwordHash" IS NULL) = ("passwordUpdatedAt" IS NULL));

-- Admin session invariants.
ALTER TABLE "AdminSession"
  ADD CONSTRAINT "AdminSession_token_hash_sha256"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "AdminSession_expires_after_create"
    CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "AdminSession_revoked_after_create"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt");
