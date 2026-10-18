CREATE TYPE "HairstyleMediaCleanupOperation" AS ENUM ('DELETE_BLOB');
CREATE TYPE "HairstyleMediaCleanupState" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "HairstyleMediaCleanupTask" (
  "id" TEXT NOT NULL,
  "hairstyleId" TEXT NOT NULL,
  "sourceMediaId" TEXT,
  "storageKey" TEXT NOT NULL,
  "operation" "HairstyleMediaCleanupOperation" NOT NULL DEFAULT 'DELETE_BLOB',
  "state" "HairstyleMediaCleanupState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastFailure" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leasedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HairstyleMediaCleanupTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HairstyleMediaCleanupTask_attempt_count" CHECK ("attemptCount" >= 0),
  CONSTRAINT "HairstyleMediaCleanupTask_lease_state" CHECK (
    ("state" = 'PROCESSING' AND "leaseToken" IS NOT NULL AND "leasedAt" IS NOT NULL)
    OR ("state" <> 'PROCESSING' AND "leaseToken" IS NULL AND "leasedAt" IS NULL)
  ),
  CONSTRAINT "HairstyleMediaCleanupTask_completed_state" CHECK (
    ("state" = 'COMPLETED' AND "completedAt" IS NOT NULL)
    OR ("state" <> 'COMPLETED' AND "completedAt" IS NULL)
  ),
  CONSTRAINT "HairstyleMediaCleanupTask_hairstyleId_fkey" FOREIGN KEY ("hairstyleId") REFERENCES "Hairstyle"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HairstyleMediaCleanupTask_sourceMediaId_key" ON "HairstyleMediaCleanupTask"("sourceMediaId");
CREATE UNIQUE INDEX "HairstyleMediaCleanupTask_storageKey_operation_key" ON "HairstyleMediaCleanupTask"("storageKey", "operation");
CREATE INDEX "HairstyleMediaCleanupTask_state_nextAttemptAt_idx" ON "HairstyleMediaCleanupTask"("state", "nextAttemptAt");
CREATE INDEX "HairstyleMediaCleanupTask_leasedAt_idx" ON "HairstyleMediaCleanupTask"("leasedAt");
CREATE INDEX "HairstyleMediaCleanupTask_hairstyleId_idx" ON "HairstyleMediaCleanupTask"("hairstyleId");
