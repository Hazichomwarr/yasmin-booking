import type { AppointmentStatus, PaymentReconciliationReason, PaymentStatus } from "@prisma/client";

import { derivePublicBookingState, type PublicBookingState } from "@/lib/booking/booking-status";

/**
 * Admin interpretation of a booking's deposit (YASMIN-2A), from stored facts
 * only. It adds no lifecycle: it labels the existing Payment states, and
 * reuses `derivePublicBookingState` for whether the booking needs a person.
 *
 * "Paid" means the charge was received AND allocated to this booking
 * (Payment.allocatedAt). A Checkout Session — open, complete-but-unapplied,
 * or of uncertain creation — is never treated as payment.
 */

export type AdminDepositState =
  /** Received and allocated to this booking. */
  | "paid"
  /** Fully refunded after being received. */
  | "refunded"
  /** Money received but not allocated (reconciliation case). */
  | "received-unallocated"
  /** Checkout Session exists; no verified payment yet. */
  | "checkout-started"
  /** A Payment exists without a recorded Session: creation outcome unknown. */
  | "checkout-uncertain"
  /** The attempt ended (expired/failed) without money. */
  | "checkout-ended"
  /** No deposit attempt was ever made. */
  | "not-started";

export const ADMIN_DEPOSIT_LABELS: Readonly<Record<AdminDepositState, string>> = {
  paid: "Deposit paid",
  refunded: "Deposit refunded",
  "received-unallocated": "Payment received — needs reconciliation",
  "checkout-started": "Checkout started — not paid",
  "checkout-uncertain": "Checkout outcome uncertain — not paid",
  "checkout-ended": "Checkout ended — not paid",
  "not-started": "No deposit payment",
};

export type DepositFacts = {
  status: PaymentStatus;
  hasCheckoutSession: boolean;
  paidAt: Date | null;
  allocatedAt: Date | null;
  refundedAmountCents: number;
  reconciliationReason: PaymentReconciliationReason | null;
} | null;

export type AdminPaymentView = {
  depositState: AdminDepositState;
  depositLabel: string;
  depositPaid: boolean;
  refundedCents: number;
  reconciliationReason: PaymentReconciliationReason | null;
  /** What remains to be collected: the balance after an allocated deposit, otherwise the full price. */
  remainingCents: number;
  /** The customer-facing state the booking flow derives from the same facts. */
  bookingState: PublicBookingState;
  /** A person must look at this booking's payment. */
  needsAttention: boolean;
};

export function depositStateOf(payment: DepositFacts): AdminDepositState {
  if (!payment) return "not-started";
  if (payment.status === "REFUNDED") return "refunded";
  if (payment.allocatedAt) return "paid";
  if (payment.paidAt) return "received-unallocated";
  switch (payment.status) {
    case "PENDING":
      return payment.hasCheckoutSession ? "checkout-started" : "checkout-uncertain";
    case "EXPIRED":
    case "FAILED":
      return "checkout-ended";
    case "PAID":
      // PAID without paidAt is excluded by a CHECK constraint; never call it paid.
      return "received-unallocated";
  }
}

export function adminPaymentView(
  appointment: { status: AppointmentStatus; holdExpiresAt: Date | null; totalPriceCents: number; balanceDueCents: number },
  payment: DepositFacts,
  unresolvedPaymentException: boolean,
  now: Date,
): AdminPaymentView {
  const depositState = depositStateOf(payment);
  const { state } = derivePublicBookingState({
    appointmentStatus: appointment.status,
    holdExpiresAt: appointment.holdExpiresAt,
    payment: payment && { status: payment.status, hasCheckoutSession: payment.hasCheckoutSession, received: payment.paidAt !== null, allocated: payment.allocatedAt !== null },
    unresolvedPaymentException,
  }, now);
  const depositPaid = depositState === "paid";
  return {
    depositState,
    depositLabel: ADMIN_DEPOSIT_LABELS[depositState],
    depositPaid,
    refundedCents: payment?.refundedAmountCents ?? 0,
    reconciliationReason: payment?.reconciliationReason ?? null,
    remainingCents: depositPaid ? appointment.balanceDueCents : appointment.totalPriceCents,
    bookingState: state,
    needsAttention: state === "needs-attention" || depositState === "received-unallocated" || unresolvedPaymentException,
  };
}
