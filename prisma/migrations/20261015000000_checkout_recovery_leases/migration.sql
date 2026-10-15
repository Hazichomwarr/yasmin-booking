-- Fences Stripe Checkout creation/recovery per existing Payment attempt.
-- No historical payment identity or provider evidence is rewritten.
ALTER TABLE "Payment"
  ADD COLUMN "checkoutRecoveryLeaseToken" TEXT,
  ADD COLUMN "checkoutRecoveryLeasedAt" TIMESTAMP(3);

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_checkout_recovery_lease_pair"
  CHECK (
    ("checkoutRecoveryLeaseToken" IS NULL AND "checkoutRecoveryLeasedAt" IS NULL)
    OR ("checkoutRecoveryLeaseToken" IS NOT NULL AND "checkoutRecoveryLeasedAt" IS NOT NULL)
  );

CREATE INDEX "Payment_checkoutRecoveryLeasedAt_idx"
  ON "Payment"("checkoutRecoveryLeasedAt");
