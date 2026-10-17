import type { AppointmentEventType, Prisma } from "@prisma/client";

type HistoryInput = {
  type: AppointmentEventType;
  at: Date;
  reason: string | null;
  details: Prisma.JsonValue | null;
  actorEmail: string | null;
};

export type AdminHistoryItem = {
  type: AppointmentEventType;
  label: string;
  at: Date;
  actorEmail: string | null;
  reason: string | null;
  transition: string | null;
  schedule: string | null;
  automated: boolean;
};

const LABELS: Record<AppointmentEventType, string> = {
  CREATED: "Booking created",
  PAYMENT_CONFIRMED: "Deposit payment confirmed",
  RESCHEDULED: "Appointment rescheduled",
  CANCELLED: "Appointment cancelled",
  COMPLETED: "Service completed",
  NO_SHOW: "Customer marked no-show",
  CUSTOMER_UPDATED: "Customer updated",
  NOTE_UPDATED: "Appointment note updated",
  HOLD_EXPIRY_CHANGED: "Booking hold updated",
  PAYMENT_RECEIVED_UNCONFIRMED: "Payment needs reconciliation",
  PAYMENT_REFUND_UPDATED: "Payment refund updated",
  ACCESS_REVOKED: "Booking access revoked",
};

function record(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function statusTransition(details: Prisma.JsonValue | null): string | null {
  const value = record(details);
  return typeof value?.fromStatus === "string" && typeof value.toStatus === "string"
    ? `${value.fromStatus.replaceAll("_", " ").toLowerCase()} → ${value.toStatus.replaceAll("_", " ").toLowerCase()}`
    : null;
}

function scheduleTransition(details: Prisma.JsonValue | null): string | null {
  const value = record(details);
  const before = record(value?.before as Prisma.JsonValue);
  const after = record(value?.after as Prisma.JsonValue);
  if (!before || !after || typeof before.appointmentDate !== "string" || typeof before.slotTime !== "string" || typeof after.appointmentDate !== "string" || typeof after.slotTime !== "string") return null;
  return `${before.appointmentDate} at ${before.slotTime} → ${after.appointmentDate} at ${after.slotTime}`;
}

/** Converts persisted append-only facts into safe human-readable history. */
export function toAdminHistoryItem(event: HistoryInput): AdminHistoryItem {
  return {
    type: event.type,
    label: LABELS[event.type],
    at: event.at,
    actorEmail: event.actorEmail,
    reason: event.reason,
    transition: statusTransition(event.details),
    schedule: event.type === "RESCHEDULED" ? scheduleTransition(event.details) : null,
    automated: event.actorEmail === null,
  };
}
