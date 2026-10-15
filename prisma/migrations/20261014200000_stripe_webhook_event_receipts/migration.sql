-- Durable signed Stripe Event receipts (YASMIN-1F.5).
--
-- The Event id is the delivery idempotency key. We intentionally store no raw
-- webhook payload, signature, customer data, or payment credentials.

-- CreateEnum
CREATE TYPE "StripeWebhookEventState" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'RECONCILIATION_REQUIRED');

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "state" "StripeWebhookEventState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "leaseToken" TEXT,
    "processingStartedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StripeWebhookEvent_id_format" CHECK ("id" ~ '^evt_[^[:space:]]+$'),
    CONSTRAINT "StripeWebhookEvent_attempt_count" CHECK ("attemptCount" >= 1),
    CONSTRAINT "StripeWebhookEvent_processed_state" CHECK (
      ("state" IN ('PENDING', 'PROCESSING') AND "processedAt" IS NULL)
      OR ("state" IN ('PROCESSED', 'RECONCILIATION_REQUIRED') AND "processedAt" IS NOT NULL)
    ),
    CONSTRAINT "StripeWebhookEvent_lease_state" CHECK (
      ("state" = 'PROCESSING' AND "leaseToken" IS NOT NULL)
      OR ("state" <> 'PROCESSING' AND "leaseToken" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_state_processingStartedAt_idx"
  ON "StripeWebhookEvent"("state", "processingStartedAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_checkoutSessionId_idx"
  ON "StripeWebhookEvent"("checkoutSessionId");
