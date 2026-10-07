import type { AppointmentEventType, AppointmentStatus } from "@prisma/client";

import { BookingError } from "./errors";

/**
 * THE appointment lifecycle policy — the only place that decides which status
 * changes are allowed.
 *
 *   PENDING_PAYMENT ──cancel──────────────▶ CANCELLED
 *   PENDING_PAYMENT ──(verified payment, YASMIN-1E only)──▶ CONFIRMED
 *   CONFIRMED ───────cancel──────────────▶ CANCELLED
 *   CONFIRMED ───────complete────────────▶ COMPLETED
 *   CONFIRMED ───────markNoShow──────────▶ NO_SHOW
 *   CONFIRMED ───────reschedule──────────▶ CONFIRMED (new slot/date)
 *
 * COMPLETED, CANCELLED and NO_SHOW are terminal: nothing leaves them.
 *
 * There is deliberately NO command here for PENDING_PAYMENT → CONFIRMED.
 * That transition belongs to verified-payment orchestration (YASMIN-1E).
 *
 * Idempotency: repeating a command whose target status the appointment is
 * already in is a no-op (no write, no event). Any other command from a
 * terminal status is rejected with INVALID_APPOINTMENT_TRANSITION.
 */

export type LifecycleCommand = "cancel" | "complete" | "markNoShow";

type TransitionRule = {
  from: readonly AppointmentStatus[];
  to: AppointmentStatus;
  event: AppointmentEventType;
};

export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleCommand, TransitionRule>> = {
  cancel: { from: ["PENDING_PAYMENT", "CONFIRMED"], to: "CANCELLED", event: "CANCELLED" },
  complete: { from: ["CONFIRMED"], to: "COMPLETED", event: "COMPLETED" },
  markNoShow: { from: ["CONFIRMED"], to: "NO_SHOW", event: "NO_SHOW" },
};

export const TERMINAL_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

export const RESCHEDULABLE_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  "CONFIRMED",
]);

/** Booking details (customer notes) can be corrected only before the visit is over. */
export const DETAIL_EDITABLE_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  "PENDING_PAYMENT",
  "CONFIRMED",
]);

export function assertDetailsEditable(status: AppointmentStatus): void {
  if (!DETAIL_EDITABLE_STATUSES.has(status)) {
    throw new BookingError(
      "APPOINTMENT_NOT_EDITABLE",
      `Booking details cannot be edited on a ${status} appointment.`,
    );
  }
}

export type TransitionDecision =
  | { kind: "apply"; to: AppointmentStatus; event: AppointmentEventType }
  | { kind: "already-applied" };

/** Decides what `command` does to an appointment currently in `status`. */
export function decideTransition(
  command: LifecycleCommand,
  status: AppointmentStatus,
): TransitionDecision {
  const rule = LIFECYCLE_TRANSITIONS[command];
  if (status === rule.to) return { kind: "already-applied" };
  if (rule.from.includes(status)) return { kind: "apply", to: rule.to, event: rule.event };

  throw new BookingError(
    "INVALID_APPOINTMENT_TRANSITION",
    `Cannot ${describe(command)} an appointment that is ${status}.`,
  );
}

export function assertReschedulable(status: AppointmentStatus): void {
  if (!RESCHEDULABLE_STATUSES.has(status)) {
    throw new BookingError(
      "APPOINTMENT_NOT_RESCHEDULABLE",
      `Only confirmed appointments can be rescheduled; this one is ${status}.`,
    );
  }
}

function describe(command: LifecycleCommand): string {
  switch (command) {
    case "cancel":
      return "cancel";
    case "complete":
      return "complete";
    case "markNoShow":
      return "mark as no-show";
  }
}
