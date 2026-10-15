CREATE TYPE "ConfirmationEmailState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

CREATE TABLE "BookingConfirmationEmail" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "state" "ConfirmationEmailState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingConfirmationEmail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingConfirmationEmail_appointmentId_key" UNIQUE ("appointmentId"),
  CONSTRAINT "BookingConfirmationEmail_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "BookingConfirmationEmail_state_createdAt_idx" ON "BookingConfirmationEmail"("state", "createdAt");
