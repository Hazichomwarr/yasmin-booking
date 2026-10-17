-- Administrator appointment actions: event attribution (YASMIN-2B.1).
--
-- AppointmentEvent gains who performed an administrator action, the
-- action's idempotency key, and the stated reason. Actor and operation are
-- set together; existing events and every system/customer event keep both
-- NULL. A reason is required for cancellation/rescheduling and optional for
-- explicit completion/no-show. The unique operationId makes a retried request
-- unable to apply the same action twice.
--
-- Existing data: purely additive. No event is rewritten; the append-only
-- history is unchanged. AdminUser rows referenced by events cannot be
-- deleted (ON DELETE RESTRICT), so attribution can never dangle.
--
-- No explicit BEGIN/COMMIT: the script runs in one transaction.

-- AlterTable
ALTER TABLE "AppointmentEvent" ADD COLUMN     "actorAdminUserId" TEXT,
ADD COLUMN     "operationId" TEXT,
ADD COLUMN     "reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentEvent_operationId_key" ON "AppointmentEvent"("operationId");

-- CreateIndex
CREATE INDEX "AppointmentEvent_actorAdminUserId_idx" ON "AppointmentEvent"("actorAdminUserId");

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_actorAdminUserId_fkey" FOREIGN KEY ("actorAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attribution invariants.
ALTER TABLE "AppointmentEvent"
  -- An administrator action always records its actor and operation together.
  ADD CONSTRAINT "AppointmentEvent_admin_attribution_complete"
    CHECK (("actorAdminUserId" IS NULL) = ("operationId" IS NULL)),
  -- The idempotency key is a canonical lowercase UUID.
  ADD CONSTRAINT "AppointmentEvent_operation_id_uuid"
    CHECK ("operationId" IS NULL OR "operationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT "AppointmentEvent_reason_text"
    CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 500 AND btrim("reason") = "reason")),
  -- Cancellation and rescheduling must preserve the administrator's reason.
  ADD CONSTRAINT "AppointmentEvent_required_action_reason"
    CHECK (
      "actorAdminUserId" IS NULL
      OR "type" NOT IN ('CANCELLED'::"AppointmentEventType", 'RESCHEDULED'::"AppointmentEventType")
      OR "reason" IS NOT NULL
    );
