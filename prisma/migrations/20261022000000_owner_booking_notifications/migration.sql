-- Independent customer and owner transactional-notification jobs (YASMIN-4B.2).
-- Existing confirmation rows remain customer notifications. No appointments,
-- payments, or historical events are modified.

CREATE TYPE "ConfirmationEmailKind" AS ENUM ('CUSTOMER_CONFIRMATION', 'OWNER_NEW_BOOKING');

ALTER TABLE "BookingConfirmationEmail"
  ADD COLUMN "kind" "ConfirmationEmailKind" NOT NULL DEFAULT 'CUSTOMER_CONFIRMATION',
  ALTER COLUMN "recipientEmail" DROP NOT NULL;

ALTER TABLE "BookingConfirmationEmail"
  DROP CONSTRAINT "BookingConfirmationEmail_appointmentId_key";

ALTER TABLE "BookingConfirmationEmail"
  ADD CONSTRAINT "BookingConfirmationEmail_appointmentId_kind_key" UNIQUE ("appointmentId", "kind");
