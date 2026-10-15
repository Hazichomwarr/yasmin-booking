-- Public booking API foundation (YASMIN-1F.4).
--
-- 1. MarketingConsentEvent: append-only evidence (channel, grant/withdrawal,
--    instant, wording version, source) for marketing consent.
-- 2. RateLimitCounter: shared, ephemeral fixed-window counters keyed by
--    HMAC digests (no raw IP, email, phone or credential is stored).
--
-- Existing data: purely additive. No existing table, row, constraint or
-- Customer consent timestamp changes. Nothing is backfilled: a Customer
-- whose emailMarketingAt/smsMarketingAt was set before this migration has no
-- MarketingConsentEvent, which is how "evidence unknown" is represented —
-- consent wording or history is never invented.
--
-- No explicit BEGIN/COMMIT: the script runs in one transaction.

-- CreateEnum
CREATE TYPE "MarketingChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "MarketingConsentAction" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "MarketingConsentSource" AS ENUM ('PUBLIC_BOOKING_FORM', 'INTERNAL_OPERATOR');

-- CreateTable
CREATE TABLE "MarketingConsentEvent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "MarketingChannel" NOT NULL,
    "action" "MarketingConsentAction" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "wordingVersion" TEXT,
    "source" "MarketingConsentSource" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("scope","keyHash","windowStart")
);

-- CreateIndex
CREATE INDEX "MarketingConsentEvent_customerId_channel_occurredAt_idx" ON "MarketingConsentEvent"("customerId", "channel", "occurredAt");

-- CreateIndex
CREATE INDEX "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");

-- AddForeignKey
ALTER TABLE "MarketingConsentEvent" ADD CONSTRAINT "MarketingConsentEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Consent evidence invariants.
ALTER TABLE "MarketingConsentEvent"
  -- A grant records exactly which wording the customer agreed to; a
  -- withdrawal is not tied to any wording.
  ADD CONSTRAINT "MarketingConsentEvent_wording_iff_granted"
    CHECK (("action" = 'GRANTED') = ("wordingVersion" IS NOT NULL)),
  ADD CONSTRAINT "MarketingConsentEvent_wording_nonblank"
    CHECK ("wordingVersion" IS NULL OR "wordingVersion" ~ '^[a-z0-9][a-z0-9.\-]{0,63}$'),
  -- Grants come only from the customer's own form submission.
  ADD CONSTRAINT "MarketingConsentEvent_grant_from_form"
    CHECK ("action" <> 'GRANTED' OR "source" = 'PUBLIC_BOOKING_FORM'),
  -- An operator-recorded event names the operator; a form event has none.
  ADD CONSTRAINT "MarketingConsentEvent_actor_iff_operator"
    CHECK (("source" = 'INTERNAL_OPERATOR') = ("actorId" IS NOT NULL)),
  ADD CONSTRAINT "MarketingConsentEvent_actor_nonblank"
    CHECK ("actorId" IS NULL OR "actorId" ~ '^\S+$');

-- Consent evidence is append-only. (TRUNCATE, used only by local tests, is a
-- statement-level operation and does not fire these row triggers.)
CREATE FUNCTION "MarketingConsentEvent_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MarketingConsentEvent is append-only (% rejected)', TG_OP;
END;
$$;

CREATE TRIGGER "MarketingConsentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "MarketingConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION "MarketingConsentEvent_append_only"();

-- Rate-limit counter invariants.
ALTER TABLE "RateLimitCounter"
  ADD CONSTRAINT "RateLimitCounter_scope_format"
    CHECK ("scope" ~ '^[a-z][a-z0-9.\-]{0,63}$'),
  -- Only an HMAC-SHA256 digest (lowercase hex), never a raw identifier.
  ADD CONSTRAINT "RateLimitCounter_key_hmac_sha256"
    CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "RateLimitCounter_count_positive"
    CHECK ("count" > 0),
  ADD CONSTRAINT "RateLimitCounter_expires_after_start"
    CHECK ("expiresAt" > "windowStart");
