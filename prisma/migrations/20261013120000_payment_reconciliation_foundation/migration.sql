-- Payment foundation for Stripe deposits (YASMIN-1E.1).
--
-- Adds checkout-expiry, allocation, refund-snapshot and reconciliation facts
-- to Payment, one deposit attempt per appointment, the new audit event types,
-- and CHECK constraints for the payment invariants (Prisma cannot express
-- CHECKs; it neither introspects nor drops them).
--
-- Existing data: nothing is backfilled. A payment that already received
-- money would need allocation or reconciliation evidence that only a human
-- can supply, so the migration fails explicitly instead of inventing it.
--
-- Enum values are only added, never used, in this script, so ADD VALUE is
-- safe inside the implicit transaction (PostgreSQL 12+). No explicit
-- BEGIN/COMMIT: a failure leaves no partial change.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Payment" GROUP BY "appointmentId", "purpose" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Several Payment rows share an (appointmentId, purpose); resolve them before applying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Payment" WHERE "paidAt" IS NOT NULL OR "status" IN ('PAID', 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'Payment rows that received money exist; their allocation/reconciliation/refund evidence must be decided explicitly before applying this migration.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "PaymentReconciliationReason" AS ENUM ('PLACE_UNAVAILABLE', 'APPOINTMENT_NOT_PAYABLE', 'AMOUNT_MISMATCH', 'REFUNDED_BEFORE_ALLOCATION');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'EXPIRED';

-- AlterEnum
ALTER TYPE "AppointmentEventType" ADD VALUE 'HOLD_EXPIRY_CHANGED';
ALTER TYPE "AppointmentEventType" ADD VALUE 'PAYMENT_RECEIVED_UNCONFIRMED';
ALTER TYPE "AppointmentEventType" ADD VALUE 'PAYMENT_REFUND_UPDATED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "allocatedAt" TIMESTAMP(3),
ADD COLUMN     "providerCheckoutExpiresAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationNote" TEXT,
ADD COLUMN     "reconciliationReason" "PaymentReconciliationReason",
ADD COLUMN     "refundedAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundsSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Payment_reconciliationReason_idx" ON "Payment"("reconciliationReason");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_appointmentId_purpose_key" ON "Payment"("appointmentId", "purpose");

-- Payment invariants.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive"
    CHECK ("amountCents" > 0),
  ADD CONSTRAINT "Payment_currency_iso"
    CHECK ("currency" ~ '^[a-z]{3}$'),
  -- Money was received exactly when the status is PAID or REFUNDED.
  ADD CONSTRAINT "Payment_received_iff_paidAt"
    CHECK (("status" IN ('PAID', 'REFUNDED')) = ("paidAt" IS NOT NULL)),
  ADD CONSTRAINT "Payment_received_has_intent"
    CHECK ("paidAt" IS NULL OR "providerPaymentIntentId" IS NOT NULL),
  ADD CONSTRAINT "Payment_allocation_needs_receipt"
    CHECK ("allocatedAt" IS NULL OR "paidAt" IS NOT NULL),
  -- A received charge is either allocated or has a reconciliation case.
  ADD CONSTRAINT "Payment_unallocated_has_case"
    CHECK ("paidAt" IS NULL OR "allocatedAt" IS NOT NULL OR "reconciliationReason" IS NOT NULL),
  ADD CONSTRAINT "Payment_case_needs_receipt"
    CHECK ("reconciliationReason" IS NULL OR "paidAt" IS NOT NULL),
  ADD CONSTRAINT "Payment_refund_bounds"
    CHECK ("refundedAmountCents" BETWEEN 0 AND "amountCents"),
  ADD CONSTRAINT "Payment_refund_needs_receipt"
    CHECK ("refundedAmountCents" = 0 OR "paidAt" IS NOT NULL),
  -- REFUNDED means the full amount was refunded; a partial refund stays PAID.
  ADD CONSTRAINT "Payment_refunded_iff_full"
    CHECK (("status" = 'REFUNDED') = ("paidAt" IS NOT NULL AND "refundedAmountCents" = "amountCents"));
