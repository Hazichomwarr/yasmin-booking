-- Durable payment exceptions (YASMIN-1E.3A).
--
-- Verified Stripe evidence that payment fulfillment could not apply because
-- its Payment association is missing, disputed or corrupt is recorded here so
-- a received charge can never disappear. Purely additive: no existing table,
-- row or constraint changes. Deliberately no foreign keys to Payment or
-- Appointment — the expected ids are unverified claims under investigation.
--
-- No explicit BEGIN/COMMIT: the script runs in one transaction.

-- CreateEnum
CREATE TYPE "PaymentExceptionCategory" AS ENUM ('IDENTITY_CONFLICT', 'CORRUPT_LOCAL_STATE', 'MISSING_ASSOCIATION', 'UNUSABLE_EVIDENCE');

-- CreateEnum
CREATE TYPE "PaymentExceptionProblem" AS ENUM ('LOCAL_RECORD_INVALID', 'ALLOCATED_BUT_APPOINTMENT_PENDING', 'CHECKOUT_SESSION_MISMATCH', 'PAYMENT_INTENT_MISMATCH', 'PAID_AT_MISMATCH', 'VERIFIED_AMOUNT_CHANGED', 'LOCAL_PAID_BUT_PROVIDER_UNPAID', 'NO_PAYMENT_REQUIRED', 'PAYMENT_NOT_FOUND', 'REFERENCE_MISMATCH', 'PROVIDER_IDENTITY_IN_USE', 'LOCATION_TIME_ZONE_INVALID');

-- CreateTable
CREATE TABLE "PaymentProcessingException" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "expectedPaymentId" TEXT,
    "expectedAppointmentId" TEXT,
    "category" "PaymentExceptionCategory" NOT NULL,
    "problem" "PaymentExceptionProblem" NOT NULL,
    "moneyReceived" BOOLEAN NOT NULL,
    "verifiedAmountCents" INTEGER,
    "verifiedCurrency" TEXT,
    "firstStripeEventId" TEXT,
    "lastStripeEventId" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,

    CONSTRAINT "PaymentProcessingException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentProcessingException_resolvedAt_lastObservedAt_idx" ON "PaymentProcessingException"("resolvedAt", "lastObservedAt");

-- CreateIndex
CREATE INDEX "PaymentProcessingException_paymentIntentId_idx" ON "PaymentProcessingException"("paymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentProcessingException_expectedPaymentId_idx" ON "PaymentProcessingException"("expectedPaymentId");

-- CreateIndex
CREATE INDEX "PaymentProcessingException_expectedAppointmentId_idx" ON "PaymentProcessingException"("expectedAppointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProcessingException_provider_checkoutSessionId_probl_key" ON "PaymentProcessingException"("provider", "checkoutSessionId", "problem");


-- Exception invariants.
ALTER TABLE "PaymentProcessingException"
  ADD CONSTRAINT "PaymentProcessingException_session_id"
    CHECK ("checkoutSessionId" ~ '^cs_\S+$'),
  ADD CONSTRAINT "PaymentProcessingException_intent_id"
    CHECK ("paymentIntentId" IS NULL OR "paymentIntentId" ~ '^pi_\S+$'),
  ADD CONSTRAINT "PaymentProcessingException_event_ids"
    CHECK (("firstStripeEventId" IS NULL OR "firstStripeEventId" ~ '^evt_\S+$')
       AND ("lastStripeEventId" IS NULL OR "lastStripeEventId" ~ '^evt_\S+$')),
  -- Received money is always identified by its charge and amount.
  ADD CONSTRAINT "PaymentProcessingException_money_has_charge"
    CHECK (NOT "moneyReceived" OR ("paymentIntentId" IS NOT NULL AND "verifiedAmountCents" IS NOT NULL)),
  ADD CONSTRAINT "PaymentProcessingException_amount_pair"
    CHECK (("verifiedAmountCents" IS NULL) = ("verifiedCurrency" IS NULL)),
  ADD CONSTRAINT "PaymentProcessingException_amount_positive"
    CHECK ("verifiedAmountCents" IS NULL OR "verifiedAmountCents" > 0),
  ADD CONSTRAINT "PaymentProcessingException_currency_iso"
    CHECK ("verifiedCurrency" IS NULL OR "verifiedCurrency" ~ '^[a-z]{3}$'),
  ADD CONSTRAINT "PaymentProcessingException_occurrences_positive"
    CHECK ("occurrenceCount" >= 1),
  ADD CONSTRAINT "PaymentProcessingException_observation_order"
    CHECK ("lastObservedAt" >= "firstObservedAt"),
  ADD CONSTRAINT "PaymentProcessingException_resolution_order"
    CHECK ("resolvedAt" IS NULL OR "resolvedAt" >= "firstObservedAt"),
  ADD CONSTRAINT "PaymentProcessingException_note_needs_resolution"
    CHECK ("resolutionNote" IS NULL OR "resolvedAt" IS NOT NULL),
  -- Each problem belongs to exactly one category.
  ADD CONSTRAINT "PaymentProcessingException_category_matches_problem"
    CHECK (
      ("category" = 'IDENTITY_CONFLICT' AND "problem" IN (
        'CHECKOUT_SESSION_MISMATCH', 'PAYMENT_INTENT_MISMATCH', 'PAID_AT_MISMATCH',
        'VERIFIED_AMOUNT_CHANGED', 'LOCAL_PAID_BUT_PROVIDER_UNPAID',
        'REFERENCE_MISMATCH', 'PROVIDER_IDENTITY_IN_USE'))
      OR ("category" = 'CORRUPT_LOCAL_STATE' AND "problem" IN (
        'LOCAL_RECORD_INVALID', 'ALLOCATED_BUT_APPOINTMENT_PENDING', 'LOCATION_TIME_ZONE_INVALID'))
      OR ("category" = 'MISSING_ASSOCIATION' AND "problem" = 'PAYMENT_NOT_FOUND')
      OR ("category" = 'UNUSABLE_EVIDENCE' AND "problem" = 'NO_PAYMENT_REQUIRED')
    );
